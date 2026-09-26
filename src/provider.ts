/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as semver from 'semver';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

import { LOGGER } from './extension';
import {
	JuliaInstallation,
	ReasonDiscovered,
	MIN_JULIA_VERSION,
	isValidJuliaInstallation
} from './julia-installation';
import {
	JuliaupInstallation,
	juliaupDirectory,
	parseJuliaupConfig,
	resolveInstallationBinary,
} from './julia-discovery';

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

const COMMAND_TIMEOUT_MS = 5000;
const JULIA_QUERY_TIMEOUT_MS = 10000;

function runCommand(
	command: string,
	args: string[],
	options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let finished = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const finish = (result: CommandResult) => {
			if (finished) {
				return;
			}
			finished = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			resolve(result);
		};

		let proc;
		try {
			proc = spawn(command, args, {
				env: options.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			finish({
				stdout,
				stderr: String(error),
				exitCode: null,
				timedOut: false,
			});
			return;
		}

		proc.stdout?.on('data', (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		timeoutId = options.timeout ? setTimeout(() => {
			proc.kill();
			finish({ stdout, stderr, exitCode: null, timedOut: true });
		}, options.timeout) : undefined;

		proc.on('error', (error) => {
			finish({
				stdout,
				stderr: `${stderr}${String(error)}`,
				exitCode: null,
				timedOut: false,
			});
		});

		proc.on('close', (code) => {
			finish({ stdout, stderr, exitCode: code, timedOut: false });
		});
	});
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
	const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
	const result = await runCommand(lookupCommand, [command], { timeout: COMMAND_TIMEOUT_MS });
	if (result.timedOut) {
		LOGGER.debug(`Timed out resolving ${command} in PATH`);
		return undefined;
	}
	if (result.exitCode !== 0 || !result.stdout) {
		return undefined;
	}
	const firstLine = result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line.length > 0);
	return firstLine || undefined;
}

/**
 * Discovers all Julia installations on the system.
 */
export async function* juliaRuntimeDiscoverer(): AsyncGenerator<JuliaInstallation> {
	const discovered = new Set<string>();

	// Helper to yield unique installations
	const yieldIfNew = function* (installation: JuliaInstallation | undefined) {
		if (installation && !discovered.has(installation.binpath)) {
			discovered.add(installation.binpath);
			if (isValidJuliaInstallation(installation)) {
				yield installation;
			} else {
				LOGGER.info(`Skipping Julia ${installation.version} (below minimum ${MIN_JULIA_VERSION})`);
			}
		}
	};

	// 0. Check user-configured executable path (highest priority, workspace-specific)
	LOGGER.debug('Checking for configured Julia executable path...');
	yield* yieldIfNew(await discoverFromConfiguredPath());

	// 1. Check PATH
	LOGGER.debug('Searching for Julia in PATH...');
	yield* yieldIfNew(await discoverFromPath());

	// 2. Check juliaup
	LOGGER.debug('Searching for Julia via juliaup...');
	for await (const installation of discoverFromJuliaup()) {
		yield* yieldIfNew(installation);
	}

	// 3. Check standard installation locations
	LOGGER.debug('Searching for Julia in standard locations...');
	for await (const installation of discoverFromStandardLocations()) {
		yield* yieldIfNew(installation);
	}
}

/**
 * Discovers Julia from the user-configured executable path or juliaup channel.
 * Reads `positron.julia.executablePath` from workspace settings, giving project-specific
 * control over which Julia version is used. The value can be either an absolute path to
 * a Julia executable or a juliaup channel name (e.g. "1.10", "lts", "release").
 */
export async function discoverFromConfiguredPath(): Promise<JuliaInstallation | undefined> {
	const config = vscode.workspace.getConfiguration('positron.julia');
	const configuredPath = config.get<string>('executablePath', '').trim();
	if (!configuredPath) {
		return undefined;
	}

	LOGGER.info(`Julia: using configured executable path: ${configuredPath}`);

	// If it looks like a path (absolute or contains a separator) treat it as a binary path.
	const looksLikePath =
		path.isAbsolute(configuredPath) ||
		configuredPath.includes('/') ||
		configuredPath.includes('\\');

	if (looksLikePath) {
		if (!fs.existsSync(configuredPath)) {
			LOGGER.warn(`Configured Julia executable not found: ${configuredPath}`);
			return undefined;
		}
		return createJuliaInstallation(configuredPath, ReasonDiscovered.USER_SETTING, true);
	}

	// Otherwise treat it as a juliaup channel name (e.g. "1.10", "lts", "release").
	const version = readJuliaupInstallations().find(v => v.channels.includes(configuredPath));
	if (!version) {
		LOGGER.warn(
			`positron.julia.executablePath is set to "${configuredPath}", ` +
			`which is not an installed juliaup channel. ` +
			`Run: juliaup add ${configuredPath}, or set an absolute path.`
		);
		return undefined;
	}
	return createJuliaInstallation(version.binpath, ReasonDiscovered.USER_SETTING, true);
}

/**
 * Discovers Julia from PATH.
 */
async function discoverFromPath(): Promise<JuliaInstallation | undefined> {
	try {
		const binpath = await resolveCommandPath('julia');
		if (binpath) {
			return await createJuliaInstallation(binpath, ReasonDiscovered.PATH, true);
		}
	} catch (error) {
		LOGGER.debug(`Failed to find Julia in PATH: ${error}`);
	}
	return undefined;
}

/**
 * Versions installed by juliaup, read from its `juliaup.json` (no
 * subprocess). The default channel's version comes first.
 */
function readJuliaupInstallations(): JuliaupInstallation[] {
	const juliaupDir = juliaupDirectory();
	const configPath = path.join(juliaupDir, 'juliaup.json');
	let content: string;
	try {
		content = fs.readFileSync(configPath, 'utf-8');
	} catch {
		return []; // juliaup is not installed
	}
	const installations = parseJuliaupConfig(content, juliaupDir);
	if (installations.length === 0) {
		LOGGER.debug(`No installed Julia versions in ${configPath}`);
	}
	return installations.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * Discovers Julia installations managed by juliaup.
 */
async function* discoverFromJuliaup(): AsyncGenerator<JuliaInstallation> {
	for (const version of readJuliaupInstallations()) {
		if (!fs.existsSync(version.binpath)) {
			LOGGER.debug(`juliaup lists ${version.binpath} (${version.channels.join(', ')}), but it does not exist`);
			continue;
		}
		const installation = await createJuliaInstallation(
			version.binpath,
			ReasonDiscovered.JULIAUP,
			version.isDefault
		);
		if (installation) {
			yield installation;
		}
	}
}

/**
 * Discovers Julia from standard installation locations.
 */
async function* discoverFromStandardLocations(): AsyncGenerator<JuliaInstallation> {
	const platform = os.platform();
	const locations: string[] = [];

	if (platform === 'darwin') {
		// macOS standard locations
		locations.push('/Applications');
		locations.push(path.join(os.homedir(), 'Applications'));

		// Check for Julia.app bundles
		for (const appDir of locations) {
			if (fs.existsSync(appDir)) {
				try {
					const entries = fs.readdirSync(appDir);
					for (const entry of entries) {
						if (entry.startsWith('Julia-') && entry.endsWith('.app')) {
							const binpath = path.join(
								appDir, entry, 'Contents', 'Resources', 'julia', 'bin', 'julia'
							);
							if (fs.existsSync(binpath)) {
								const installation = await createJuliaInstallation(
									binpath,
									ReasonDiscovered.STANDARD,
									false
								);
								if (installation) {
									yield installation;
								}
							}
						}
					}
				} catch (error) {
					LOGGER.debug(`Failed to search ${appDir}: ${error}`);
				}
			}
		}
	} else if (platform === 'linux') {
		// Linux standard locations
		const linuxPaths = [
			'/usr/bin/julia',
			'/usr/local/bin/julia',
			'/opt/julia/bin/julia',
		];

		// Also check /opt for versioned installations
		if (fs.existsSync('/opt')) {
			try {
				const entries = fs.readdirSync('/opt');
				for (const entry of entries) {
					if (entry.startsWith('julia-')) {
						linuxPaths.push(path.join('/opt', entry, 'bin', 'julia'));
					}
				}
			} catch (error) {
				LOGGER.debug(`Failed to search /opt: ${error}`);
			}
		}

		for (const binpath of linuxPaths) {
			if (fs.existsSync(binpath)) {
				const installation = await createJuliaInstallation(
					binpath,
					ReasonDiscovered.STANDARD,
					false
				);
				if (installation) {
					yield installation;
				}
			}
		}
	} else if (platform === 'win32') {
		// Windows standard locations
		const localAppData = process.env.LOCALAPPDATA || '';
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

		const windowsPaths: string[] = [];

		// Check LocalAppData for user installations
		if (localAppData) {
			const juliaDir = path.join(localAppData, 'Programs');
			if (fs.existsSync(juliaDir)) {
				try {
					const entries = fs.readdirSync(juliaDir);
					for (const entry of entries) {
						if (entry.startsWith('Julia-') || entry.startsWith('Julia ')) {
							windowsPaths.push(path.join(juliaDir, entry, 'bin', 'julia.exe'));
						}
					}
				} catch (error) {
					LOGGER.debug(`Failed to search ${juliaDir}: ${error}`);
				}
			}
		}

		// Check Program Files
		if (fs.existsSync(programFiles)) {
			try {
				const entries = fs.readdirSync(programFiles);
				for (const entry of entries) {
					if (entry.startsWith('Julia-') || entry.startsWith('Julia ')) {
						windowsPaths.push(path.join(programFiles, entry, 'bin', 'julia.exe'));
					}
				}
			} catch (error) {
				LOGGER.debug(`Failed to search ${programFiles}: ${error}`);
			}
		}

		for (const binpath of windowsPaths) {
			if (fs.existsSync(binpath)) {
				const installation = await createJuliaInstallation(
					binpath,
					ReasonDiscovered.STANDARD,
					false
				);
				if (installation) {
					yield installation;
				}
			}
		}
	}
}

/**
 * Creates a JuliaInstallation from a binary path by querying Julia for its info.
 */
async function createJuliaInstallation(
	binpath: string,
	reasonDiscovered: ReasonDiscovered,
	current: boolean
): Promise<JuliaInstallation | undefined> {
	try {
		// Get version and system info from Julia
		const versionScript = `
			println(VERSION)
			println(Sys.BINDIR)
			println(Sys.ARCH)
			release_date = try
				split(String(Base.GIT_VERSION_INFO.date_string), ' ')[1]
			catch
				""
			end
			println(release_date)
		`;

		const result = await runCommand(binpath, ['-e', versionScript], {
			timeout: JULIA_QUERY_TIMEOUT_MS,
		});

		if (result.timedOut) {
			LOGGER.debug(`Timed out getting Julia info from ${binpath}`);
			return undefined;
		}

		if (result.exitCode !== 0) {
			LOGGER.debug(`Failed to get Julia info from ${binpath}: ${result.stderr}`);
			return undefined;
		}

		const lines = result.stdout.trim().split('\n');
		if (lines.length < 3) {
			LOGGER.debug(`Unexpected output from Julia at ${binpath}`);
			return undefined;
		}

		const version = lines[0].trim();
		const homepath = lines[1].trim();
		// Identify the installation by its own binary, not a launcher for it.
		const installationBinpath = resolveInstallationBinary(binpath, homepath);
		if (installationBinpath !== binpath) {
			LOGGER.info(`Resolved Julia launcher ${binpath} -> ${installationBinpath}`);
		}
		const arch = lines[2].trim();
		const releaseDateLine = lines[3]?.trim();
		const releaseDate = releaseDateLine && /^\d{4}-\d{2}-\d{2}$/.test(releaseDateLine)
			? releaseDateLine
			: undefined;

		const semVersion = semver.parse(version);
		if (!semVersion) {
			LOGGER.debug(`Failed to parse Julia version: ${version}`);
			return undefined;
		}

		return {
			binpath: installationBinpath,
			homepath,
			version,
			semVersion,
			arch,
			releaseDate,
			reasonDiscovered,
			current,
		};
	} catch (error) {
		LOGGER.debug(`Failed to create installation from ${binpath}: ${error}`);
		return undefined;
	}
}
