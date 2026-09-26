/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Filesystem facts behind Julia runtime discovery: where Julia installations
 * live, which binary identifies an installation, and a cheap fingerprint of
 * those locations. Positron's discovery cache (2026.06+) compares the
 * fingerprint between startups to decide whether discovery must run again.
 *
 * No dependency on `vscode` or `positron`, so it can be unit tested under
 * plain Node.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Name of the Julia executable on `platform`. */
export function juliaExecutableName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'julia.exe' : 'julia';
}

/**
 * The binary that identifies the installation `binpath` ran, given its
 * `Sys.BINDIR` (`homepath`). A launcher or shim (the juliaup `julia`, a
 * Windows app-execution alias) is replaced by the installation's own binary,
 * which is what actually answered, so that it deduplicates against the same
 * installation found elsewhere and can be cached. A path that is the same
 * file as the installation's binary (e.g. a Homebrew or `/usr/local/bin`
 * symlink) is kept, since it survives upgrades.
 */
export function resolveInstallationBinary(
	binpath: string,
	homepath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const own = path.join(homepath, juliaExecutableName(platform));
	if (!path.isAbsolute(homepath) || !isFile(own)) {
		return binpath; // unusual layout: keep what we ran
	}
	try {
		if (fs.realpathSync(binpath) === fs.realpathSync(own)) {
			return binpath;
		}
	} catch {
		// e.g. an app-execution alias that cannot be resolved; `own` is still
		// the binary of the Julia that answered.
	}
	return own;
}

/** The juliaup directory (`$JULIAUP_DEPOT_PATH/juliaup`, default `~/.julia/juliaup`). */
export function juliaupDirectory(
	env: NodeJS.ProcessEnv = process.env,
	homedir: string = os.homedir(),
): string {
	const depot = env.JULIAUP_DEPOT_PATH || path.join(homedir, '.julia');
	return path.join(depot, 'juliaup');
}

/** A Julia version installed by juliaup. */
export interface JuliaupInstallation {
	/** Absolute path of the version's `julia` binary. */
	readonly binpath: string;
	/** Channels (e.g. `release`, `1.12`) that currently point to this version. */
	readonly channels: readonly string[];
	/** Whether the default channel points to this version. */
	readonly isDefault: boolean;
}

/**
 * The versions installed by juliaup, from the contents of its `juliaup.json`.
 * Current juliaup records each binary in `BinaryPath` (on macOS it lives in a
 * `Julia-x.y.app` bundle); older configs only have `Path`, with the binary in
 * `bin/`. Linked channels (`juliaup link`) have no installed version and are
 * not listed. Returns `[]` for a config that cannot be parsed.
 */
export function parseJuliaupConfig(
	content: string,
	juliaupDir: string,
	platform: NodeJS.Platform = process.platform,
): JuliaupInstallation[] {
	let config: {
		Default?: string;
		InstalledVersions?: Record<string, { Path?: string; BinaryPath?: string }>;
		InstalledChannels?: Record<string, { Version?: string }>;
	};
	try {
		config = JSON.parse(content);
	} catch {
		return [];
	}
	const channelsByVersion = new Map<string, string[]>();
	for (const [channel, info] of Object.entries(config.InstalledChannels ?? {})) {
		if (info?.Version) {
			channelsByVersion.set(info.Version, [...(channelsByVersion.get(info.Version) ?? []), channel]);
		}
	}
	const defaultVersion = config.Default ? config.InstalledChannels?.[config.Default]?.Version : undefined;
	const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(juliaupDir, p);

	const installations: JuliaupInstallation[] = [];
	for (const [version, info] of Object.entries(config.InstalledVersions ?? {})) {
		const binpath = info?.BinaryPath
			? resolve(info.BinaryPath)
			: info?.Path ? path.join(resolve(info.Path), 'bin', juliaExecutableName(platform)) : undefined;
		if (binpath) {
			installations.push({
				binpath: path.normalize(binpath),
				channels: channelsByVersion.get(version) ?? [],
				isDefault: version === defaultVersion,
			});
		}
	}
	return installations;
}

/**
 * Directories and files whose changes can add or remove a Julia installation
 * that discovery would find: the juliaup directory and its config, and the
 * standard install locations searched on `platform`.
 */
export function discoveryRoots(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	homedir: string = os.homedir(),
): string[] {
	const juliaup = juliaupDirectory(env, homedir);
	const roots = [juliaup, path.join(juliaup, 'juliaup.json')];
	if (platform === 'darwin') {
		roots.push('/Applications', path.join(homedir, 'Applications'));
	} else if (platform === 'linux') {
		roots.push('/opt', '/opt/julia/bin/julia', '/usr/bin/julia', '/usr/local/bin/julia');
	} else if (platform === 'win32') {
		if (env.LOCALAPPDATA) {
			roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs'));
		}
		roots.push(env.ProgramFiles || 'C:\\Program Files');
	}
	return roots;
}

/** The `julia` executables on `PATH`, in PATH order, without duplicates. */
export function juliaExecutablesOnPath(
	pathValue: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const delimiter = platform === 'win32' ? ';' : ':';
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	const found: string[] = [];
	for (const dir of (pathValue ?? '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, juliaExecutableName(platform));
		if (!found.includes(candidate) && fs.existsSync(candidate)) {
			found.push(candidate);
		}
	}
	return found;
}

/** Structurally compatible with `positron.RuntimeRootEntry`. */
export interface DiscoveryRootEntry {
	readonly path: string;
	readonly exists: boolean;
	readonly mtimeMs: number;
}

/**
 * One `stat` per path. Symlinks are followed, so upgrading the Julia a PATH
 * symlink points to changes its entry.
 */
export function statDiscoveryRoot(p: string): DiscoveryRootEntry {
	try {
		const stat = fs.statSync(p);
		let resolved = p;
		try {
			resolved = fs.realpathSync(p);
		} catch {
			// keep the unresolved path
		}
		return { path: resolved, exists: true, mtimeMs: stat.mtimeMs };
	} catch {
		return { path: p, exists: false, mtimeMs: 0 };
	}
}

/**
 * Fingerprint of everything discovery looks at: the standard roots, then the
 * `julia` executables on PATH.
 */
export function discoveryRootEntries(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	homedir: string = os.homedir(),
): DiscoveryRootEntry[] {
	return [
		...discoveryRoots(platform, env, homedir),
		...juliaExecutablesOnPath(env.PATH ?? env.Path, platform),
	].map(statDiscoveryRoot);
}

/** Positron's architecture label for Julia's `Sys.ARCH`. */
export function runtimeArchitecture(arch: string): 'arm64' | 'x64' | 'other' {
	switch (arch) {
		case 'aarch64':
		case 'arm64':
			return 'arm64';
		case 'x86_64':
		case 'x64':
			return 'x64';
		default:
			return 'other';
	}
}
