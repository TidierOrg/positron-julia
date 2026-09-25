/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the filesystem facts behind Julia discovery and Positron's
// discovery cache. Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	discoveryRootEntries,
	discoveryRoots,
	juliaExecutableName,
	juliaExecutablesOnPath,
	juliaupDirectory,
	parseJuliaupConfig,
	resolveInstallationBinary,
	runtimeArchitecture,
	statDiscoveryRoot,
} from '../../julia-discovery';

const exe = juliaExecutableName();

/** A fake installation: `<root>/julia-1.11/bin/julia`. Returns its bin dir. */
function makeInstallation(root: string, name = 'julia-1.11'): string {
	const bindir = path.join(root, name, 'bin');
	fs.mkdirSync(bindir, { recursive: true });
	fs.writeFileSync(path.join(bindir, exe), '#!/bin/sh\n', { mode: 0o755 });
	return bindir;
}

suite('Julia discovery: installation binary', () => {
	let tmp: string;
	setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'julia-discovery-')); });
	teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

	test('a launcher is replaced by the installation binary', () => {
		const bindir = makeInstallation(tmp);
		const launcher = path.join(tmp, 'juliaup-bin', exe);
		fs.mkdirSync(path.dirname(launcher));
		fs.writeFileSync(launcher, 'launcher');
		assert.strictEqual(resolveInstallationBinary(launcher, bindir), path.join(bindir, exe));
	});

	test('the installation binary itself is kept', () => {
		const bindir = makeInstallation(tmp);
		const own = path.join(bindir, exe);
		assert.strictEqual(resolveInstallationBinary(own, bindir), own);
	});

	test('a symlink to the installation binary is kept (survives upgrades)', function () {
		if (process.platform === 'win32') {
			this.skip(); // symlinks need privileges on Windows
		}
		const bindir = makeInstallation(tmp);
		const link = path.join(tmp, 'usr-local-bin-julia');
		fs.symlinkSync(path.join(bindir, exe), link);
		assert.strictEqual(resolveInstallationBinary(link, bindir), link);
	});

	test('an unusual layout without a binary in Sys.BINDIR keeps the original path', () => {
		const binpath = path.join(tmp, 'somewhere', exe);
		assert.strictEqual(resolveInstallationBinary(binpath, path.join(tmp, 'no-such-bindir')), binpath);
	});

	test('a relative or empty Sys.BINDIR, or a directory named julia, is never used', () => {
		const binpath = path.join(tmp, 'launcher', exe);
		fs.mkdirSync(path.join(tmp, 'rel', exe), { recursive: true }); // a *directory* named julia
		assert.strictEqual(resolveInstallationBinary(binpath, ''), binpath);
		assert.strictEqual(resolveInstallationBinary(binpath, path.join(tmp, 'rel')), binpath);
	});

	test('an unresolvable launcher falls back to the installation binary', () => {
		const bindir = makeInstallation(tmp);
		const missingLauncher = path.join(tmp, 'WindowsApps', exe); // realpath throws
		assert.strictEqual(resolveInstallationBinary(missingLauncher, bindir), path.join(bindir, exe));
	});
});

suite('Julia discovery: juliaup config', () => {
	const dir = path.join('/home/u', '.julia', 'juliaup');

	test('current juliaup: BinaryPath (macOS .app bundles), channels and default', () => {
		const config = JSON.stringify({
			Default: 'release',
			InstalledVersions: {
				'1.13.0+0.aarch64.apple.darwin14': {
					Path: './julia-1.13.0+0.aarch64.apple.darwin14',
					BinaryPath: './julia-1.13.0+0.aarch64.apple.darwin14/Julia-1.13.app/Contents/Resources/julia/bin/julia',
				},
				'1.12.7+0.aarch64.apple.darwin14': {
					Path: './julia-1.12.7+0.aarch64.apple.darwin14',
					BinaryPath: './julia-1.12.7+0.aarch64.apple.darwin14/Julia-1.12.app/Contents/Resources/julia/bin/julia',
				},
			},
			InstalledChannels: {
				release: { Version: '1.13.0+0.aarch64.apple.darwin14' },
				'1.12': { Version: '1.12.7+0.aarch64.apple.darwin14' },
			},
		});
		assert.deepStrictEqual(parseJuliaupConfig(config, dir, 'darwin'), [
			{
				binpath: path.join(dir, 'julia-1.13.0+0.aarch64.apple.darwin14/Julia-1.13.app/Contents/Resources/julia/bin/julia'),
				channels: ['release'],
				isDefault: true,
			},
			{
				binpath: path.join(dir, 'julia-1.12.7+0.aarch64.apple.darwin14/Julia-1.12.app/Contents/Resources/julia/bin/julia'),
				channels: ['1.12'],
				isDefault: false,
			},
		]);
	});

	test('older juliaup: Path only, binary in bin/; two channels on one version', () => {
		const config = JSON.stringify({
			Default: 'lts',
			InstalledVersions: { '1.10.10+0.x64.linux.gnu': { Path: './julia-1.10.10+0.x64.linux.gnu' } },
			InstalledChannels: {
				lts: { Version: '1.10.10+0.x64.linux.gnu' },
				'1.10': { Version: '1.10.10+0.x64.linux.gnu' },
			},
		});
		assert.deepStrictEqual(parseJuliaupConfig(config, dir, 'linux'), [{
			binpath: path.join(dir, 'julia-1.10.10+0.x64.linux.gnu', 'bin', 'julia'),
			channels: ['lts', '1.10'],
			isDefault: true,
		}]);
	});

	test('linked channels and unparsable configs yield nothing', () => {
		const linked = JSON.stringify({
			Default: 'dev',
			InstalledVersions: {},
			InstalledChannels: { dev: { Command: '/src/julia/julia', Args: [] } },
		});
		assert.deepStrictEqual(parseJuliaupConfig(linked, dir, 'linux'), []);
		assert.deepStrictEqual(parseJuliaupConfig('{ not json', dir, 'linux'), []);
	});
});

suite('Julia discovery: roots', () => {
	test('juliaup directory honors JULIAUP_DEPOT_PATH', () => {
		assert.strictEqual(juliaupDirectory({}, '/home/u'), path.join('/home/u', '.julia', 'juliaup'));
		assert.strictEqual(juliaupDirectory({ JULIAUP_DEPOT_PATH: '/depot' }, '/home/u'), path.join('/depot', 'juliaup'));
	});

	test('roots per platform start with juliaup and list the standard locations', () => {
		const juliaup = path.join('/h', '.julia', 'juliaup');
		assert.deepStrictEqual(discoveryRoots('darwin', {}, '/h'), [
			juliaup, path.join(juliaup, 'juliaup.json'), '/Applications', path.join('/h', 'Applications'),
		]);
		assert.deepStrictEqual(discoveryRoots('linux', {}, '/h'), [
			juliaup, path.join(juliaup, 'juliaup.json'),
			'/opt', '/opt/julia/bin/julia', '/usr/bin/julia', '/usr/local/bin/julia',
		]);
		const win = discoveryRoots('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\PF' }, '/h');
		assert.deepStrictEqual(win.slice(2), ['C:\\Users\\u\\AppData\\Local\\Programs', 'C:\\PF']);
	});
});

suite('Julia discovery: PATH and signature', () => {
	let tmp: string;
	setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'julia-discovery-')); });
	teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

	test('julia executables on PATH, in order, without duplicates or empty entries', () => {
		const a = makeInstallation(tmp, 'a');
		const b = makeInstallation(tmp, 'b');
		const empty = path.join(tmp, 'empty');
		fs.mkdirSync(empty);
		const value = ['', b, empty, a, b].join(path.delimiter);
		assert.deepStrictEqual(juliaExecutablesOnPath(value), [path.join(b, exe), path.join(a, exe)]);
		assert.deepStrictEqual(juliaExecutablesOnPath(undefined), []);
	});

	test('a missing root is recorded as absent', () => {
		assert.deepStrictEqual(statDiscoveryRoot(path.join(tmp, 'nope')), {
			path: path.join(tmp, 'nope'), exists: false, mtimeMs: 0,
		});
	});

	test('a symlinked PATH julia reflects its target, so an in-place upgrade changes the signature', function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const bindir = makeInstallation(tmp);
		const target = path.join(bindir, exe);
		const link = path.join(tmp, 'julia-link');
		fs.symlinkSync(target, link);

		const before = statDiscoveryRoot(link);
		assert.strictEqual(before.path, fs.realpathSync(target));
		assert.strictEqual(before.exists, true);

		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(target, later, later);
		assert.notStrictEqual(statDiscoveryRoot(link).mtimeMs, before.mtimeMs);
	});

	test('the signature lists the roots, then the PATH executables', () => {
		const bindir = makeInstallation(tmp);
		const entries = discoveryRootEntries('linux', { PATH: bindir }, tmp);
		assert.strictEqual(entries.length, discoveryRoots('linux', {}, tmp).length + 1);
		assert.strictEqual(entries[entries.length - 1].path, fs.realpathSync(path.join(bindir, exe)));
	});
});

suite('Julia discovery: architecture', () => {
	test('maps Sys.ARCH to Positron architectures', () => {
		assert.strictEqual(runtimeArchitecture('aarch64'), 'arm64');
		assert.strictEqual(runtimeArchitecture('x86_64'), 'x64');
		assert.strictEqual(runtimeArchitecture('arm64'), 'arm64');
		assert.strictEqual(runtimeArchitecture('i686'), 'other');
	});
});
