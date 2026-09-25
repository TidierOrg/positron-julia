/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';
import * as semver from 'semver';

import { LOGGER, supervisorApi, ensureLanguageServerForVersion } from './extension';
import { discoverFromConfiguredPath, juliaRuntimeDiscoverer } from './provider';
import { JuliaSession } from './session';
import { JuliaInstallation, ReasonDiscovered, isValidJuliaInstallation } from './julia-installation';
import { discoveryRootEntries } from './julia-discovery';
import { resolveWorkspaceJuliaProject } from './environment';
import { createJuliaRuntimeMetadata, getJuliaRuntimeIconBase64 } from './runtime';
import { createJuliaKernelSpec } from './kernel-spec';

/**
 * Extra runtime data stored in Julia runtime metadata.
 */
interface JuliaExtraRuntimeData {
	homepath: string;
	arch: string;
	releaseDate?: string;
}

/**
 * Manages Julia runtimes for Positron.
 */
export class JuliaRuntimeManager implements positron.LanguageRuntimeManager {

	private readonly _context: vscode.ExtensionContext;

	/** Map of runtime ID to Julia installation */
	private readonly _installations = new Map<string, JuliaInstallation>();

	/** Map of session ID to active JuliaSession (for interrupt etc.) */
	private readonly _activeSessions = new Map<string, JuliaSession>();

	getActiveJuliaSession(): JuliaSession | undefined {
		for (const session of this._activeSessions.values()) {
			return session;
		}
		return undefined;
	}

	/**
	 * Best Julia installation for auxiliary tooling (the language server, the
	 * create-package command): the active session's installation, else one
	 * found this window, else Positron's preferred Julia runtime, else the
	 * first one discovery finds.
	 *
	 * On a warm start Positron may skip discovery and register cached runtimes
	 * directly, so `_installations` can be empty even though Julia is known.
	 */
	async getPreferredInstallation(): Promise<JuliaInstallation | undefined> {
		const session = this.getActiveJuliaSession();
		if (session) {
			return session.installation;
		}
		for (const installation of this._installations.values()) {
			return installation;
		}
		try {
			const preferred = await positron.runtime.getPreferredRuntime('julia');
			if (preferred) {
				return this.getOrReconstructInstallation(preferred);
			}
		} catch (error) {
			LOGGER.debug(`No preferred Julia runtime from Positron: ${error}`);
		}
		for await (const installation of juliaRuntimeDiscoverer()) {
			return installation;
		}
		return undefined;
	}

	/**
	 * The runtime from `positron.julia.executablePath`, if set. Positron calls
	 * this on every start, before (and even without) discovery, so the
	 * workspace's configured Julia is offered even when cached runtimes let
	 * Positron skip discovery.
	 */
	async recommendedWorkspaceRuntime(): Promise<positron.LanguageRuntimeMetadata | undefined> {
		const installation = await discoverFromConfiguredPath();
		if (!installation || !isValidJuliaInstallation(installation)) {
			return undefined;
		}
		const metadata = createJuliaRuntimeMetadata(installation, this._context.extensionPath);
		this._installations.set(metadata.runtimeId, installation);
		return metadata;
	}

	/**
	 * Fingerprint of the locations discovery searches, one `stat` each.
	 * Positron reruns discovery on startup only when this changes (or the
	 * cache is old), e.g. after `juliaup add` or a new Julia on PATH.
	 */
	async getDiscoveryRootSignature(): Promise<positron.RuntimeRootSignature> {
		return { entries: discoveryRootEntries() };
	}

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	/**
	 * Gets a Julia installation from the cache or reconstructs it from runtime metadata.
	 * This is needed because session restoration may happen before runtime discovery completes.
	 */
	private getOrReconstructInstallation(
		runtimeMetadata: positron.LanguageRuntimeMetadata
	): JuliaInstallation {
		// First, try to get from the cache
		const cached = this._installations.get(runtimeMetadata.runtimeId);
		if (cached) {
			return cached;
		}

		// Otherwise, reconstruct from runtime metadata
		const extraData = runtimeMetadata.extraRuntimeData as JuliaExtraRuntimeData;
		if (!extraData?.homepath) {
			throw new Error(`Cannot reconstruct Julia installation: missing extraRuntimeData`);
		}

		LOGGER.debug(`Reconstructing Julia installation from metadata for ${runtimeMetadata.runtimeName}`);
		const parsedVersion = semver.parse(runtimeMetadata.languageVersion);
		if (!parsedVersion) {
			throw new Error(`Cannot parse Julia version: ${runtimeMetadata.languageVersion}`);
		}
		return {
			binpath: runtimeMetadata.runtimePath,
			homepath: extraData.homepath,
			version: runtimeMetadata.languageVersion,
			semVersion: parsedVersion,
			arch: extraData.arch || process.arch,
			releaseDate: extraData.releaseDate,
			current: false,
			reasonDiscovered: ReasonDiscovered.PATH,
		};
	}

	/**
	 * Discovers all available Julia runtimes on the system.
	 */
	async* discoverAllRuntimes(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
		LOGGER.info('Discovering Julia runtimes...');

		for await (const installation of juliaRuntimeDiscoverer()) {
			const metadata = createJuliaRuntimeMetadata(installation, this._context.extensionPath);
			this._installations.set(metadata.runtimeId, installation);
			LOGGER.info(`Discovered Julia ${installation.version} at ${installation.binpath}`);
			yield metadata;
		}
	}

	/**
	 * Creates a new Julia session for the given runtime.
	 */
	async createSession(
		runtimeMetadata: positron.LanguageRuntimeMetadata,
		sessionMetadata: positron.RuntimeSessionMetadata
	): Promise<positron.LanguageRuntimeSession> {
		const installation = this.getOrReconstructInstallation(runtimeMetadata);

		// Ensure Language Server is running with the correct Julia version
		// This handles switching between Julia versions gracefully
		await ensureLanguageServerForVersion(installation, this._context);

		// The same project the status bar shows: the environment the user picked,
		// else the workspace's own project, else the global environment.
		const project = resolveWorkspaceJuliaProject();
		if (project.missingSetting) {
			LOGGER.warn(`Configured Julia environment does not exist: ${project.missingSetting}`);
		}
		LOGGER.info(`Julia console project: ${project.path ?? 'global environment'} (${project.reason})`);

		// Create the kernel spec for a new session
		const kernelSpec = createJuliaKernelSpec(installation, project.path, project.explicit);

		LOGGER.info(`Creating Julia session for ${runtimeMetadata.runtimeName}`);
		const session = new JuliaSession(
			runtimeMetadata,
			sessionMetadata,
			installation,
			this._context.extensionPath,
			kernelSpec
		);
		this._activeSessions.set(sessionMetadata.sessionId, session);
		session.onDidEndSession(() => this._activeSessions.delete(sessionMetadata.sessionId));
		return session;
	}

	/**
	 * Restores an existing Julia session.
	 * When restoring, we don't pass a kernel spec so the session reconnects
	 * to the existing kernel rather than starting a new one.
	 */
	async restoreSession(
		runtimeMetadata: positron.LanguageRuntimeMetadata,
		sessionMetadata: positron.RuntimeSessionMetadata,
		sessionName: string
	): Promise<positron.LanguageRuntimeSession> {
		const installation = this.getOrReconstructInstallation(runtimeMetadata);

		// Ensure Language Server is running when restoring a session
		// This handles the case where Positron was reloaded and the LS needs to be started
		await ensureLanguageServerForVersion(installation, this._context);

		LOGGER.info(`Restoring Julia session for ${runtimeMetadata.runtimeName}`);
		// Don't pass kernelSpec so the session will reconnect to the existing kernel
		const session = new JuliaSession(
			runtimeMetadata,
			sessionMetadata,
			installation,
			this._context.extensionPath,
			undefined,  // No kernel spec for restore
			sessionName
		);
		this._activeSessions.set(sessionMetadata.sessionId, session);
		session.onDidEndSession(() => this._activeSessions.delete(sessionMetadata.sessionId));
		return session;
	}

	/**
	 * Validates an existing session to check if it can be restored.
	 *
	 * @param sessionId The session ID to validate
	 * @returns True if the session is valid and can be restored, false otherwise
	 */
	async validateSession(sessionId: string): Promise<boolean> {
		const api = await supervisorApi();
		return await api.validateSession(sessionId);
	}

	/**
	 * Validates session metadata to check if a session can be restored.
	 */
	async validateMetadata(
		metadata: positron.LanguageRuntimeMetadata
	): Promise<positron.LanguageRuntimeMetadata> {
		return {
			...metadata,
			base64EncodedIconSvg: getJuliaRuntimeIconBase64(this._context.extensionPath),
		};
	}
}
