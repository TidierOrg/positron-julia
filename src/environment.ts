/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LOGGER } from './extension';
import { JuliaLanguageClient } from './lsp';
import { JuliaProjectResolution, hasJuliaProjectFile, resolveJuliaProject } from './julia-project';
import { juliaStringLiteral } from './julia-data-import';

interface EnvQuickPickItem extends vscode.QuickPickItem {
	/** The project to activate, or undefined to clear the explicit choice. */
	envPath: string | undefined;
}

/**
 * The active Julia project for this workspace, shared by the status bar, the
 * console kernel and the language server (see `julia-project.ts`). Pass
 * `activeFile` to search from that file's folder (the language server does,
 * for static analysis of multi-project workspaces).
 */
export function resolveWorkspaceJuliaProject(activeFile?: string): JuliaProjectResolution {
	return resolveJuliaProject({
		configuredPath: vscode.workspace.getConfiguration('positron.julia')
			.get<string>('languageServer.environmentPath', ''),
		workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
		activeFile,
	});
}

/** `@v1.12`-style name of the global environment, when the Julia version is known. */
function globalEnvironmentName(session: positron.LanguageRuntimeSession | undefined): string {
	const minor = session?.runtimeMetadata.languageVersion.match(/^(\d+\.\d+)/)?.[1];
	return minor ? `@v${minor}` : 'global';
}

/**
 * Manages the Julia project environment: status bar display and switching.
 */
export class JuliaEnvironmentManager implements vscode.Disposable {
	private readonly _statusBarItem: vscode.StatusBarItem;
	private _current: JuliaProjectResolution | undefined;
	private _getSession: () => positron.LanguageRuntimeSession | undefined = () => undefined;
	private readonly _onDidChangeProject = new vscode.EventEmitter<string | undefined>();

	/** Fires with the new project directory (undefined = global) after a switch. */
	readonly onDidChangeProject = this._onDidChangeProject.event;

	/** The active project directory, or undefined for the global environment. */
	get currentProject(): string | undefined {
		return this._current?.path;
	}

	constructor() {
		this._statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100
		);
		this._statusBarItem.command = 'julia.changeCurrentEnvironment';
		this._statusBarItem.tooltip = 'Julia environment — click to change';
	}

	activate(
		context: vscode.ExtensionContext,
		getClient: () => JuliaLanguageClient | undefined,
		getSession: () => positron.LanguageRuntimeSession | undefined
	): void {
		context.subscriptions.push(this);
		this._getSession = getSession;

		// Same resolution the console kernel uses when a session starts
		this._current = resolveWorkspaceJuliaProject();
		this._updateStatusBar();
		this._statusBarItem.show();

		context.subscriptions.push(
			// Resolves to true when the user picked an environment
			vscode.commands.registerCommand('julia.changeCurrentEnvironment', () =>
				this._changeEnvironment(getClient, getSession)
			),
			// The global environment's name depends on the session's Julia version
			positron.runtime.onDidChangeForegroundSession(() => this._updateStatusBar()),
		);

		// Update status bar when active editor changes to a Julia file
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor?.document.languageId === 'julia') {
					this._statusBarItem.show();
				}
			})
		);
	}

	private async _changeEnvironment(
		getClient: () => JuliaLanguageClient | undefined,
		getSession: () => positron.LanguageRuntimeSession | undefined
	): Promise<boolean> {
		const items = await this._buildEnvList();
		if (items.length === 0) {
			vscode.window.showInformationMessage('No Julia environments found.');
			return false;
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a Julia project environment',
			matchOnDescription: true,
		});

		if (!selected) {
			return false;
		}

		if (selected.envPath === undefined) {
			await this._clearExplicitProject(getSession());
		} else {
			await this._switchToPath(selected.envPath, getClient(), getSession());
		}
		return true;
	}

	private async _buildEnvList(): Promise<EnvQuickPickItem[]> {
		const items: EnvQuickPickItem[] = [];
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

		// 1. Workspace folders that are not projects yet (issue #29): make one
		// the project explicitly. Pkg creates Project.toml on the first `add`.
		for (const folder of workspaceFolders) {
			if (!hasJuliaProjectFile(folder.uri.fsPath)) {
				items.push({
					label: `$(new-folder) Activate '${folder.name}' as a new project`,
					description: folder.uri.fsPath,
					envPath: folder.uri.fsPath,
				});
			}
		}

		// 2. Workspace Project.toml files
		for (const folder of workspaceFolders) {
			await this._collectProjectFiles(folder.uri.fsPath, items, 3);
		}

		// 3. ~/.julia/environments/v*
		const homeEnvsDir = path.join(os.homedir(), '.julia', 'environments');
		if (fs.existsSync(homeEnvsDir)) {
			try {
				const entries = fs.readdirSync(homeEnvsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const envPath = path.join(homeEnvsDir, entry.name);
						const projFile = path.join(envPath, 'Project.toml');
						if (fs.existsSync(projFile)) {
							items.push({
								label: `$(home) ${entry.name}`,
								description: envPath,
								envPath,
							});
						}
					}
				}
			} catch {
				// Ignore read errors
			}
		}

		// 4. Undo an explicit choice
		if (this._current?.explicit) {
			const fallback = this._resolveWithoutSetting();
			items.push({
				label: '$(discard) Use the workspace default',
				description: fallback.path ?? `global environment (${globalEnvironmentName(this._getSession())})`,
				envPath: undefined,
			});
		}

		return items;
	}

	/** What the workspace resolves to without the explicit setting. */
	private _resolveWithoutSetting(): JuliaProjectResolution {
		return resolveJuliaProject({
			workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
		});
	}

	/**
	 * Clears `positron.julia.languageServer.environmentPath` and returns the
	 * console and language server to the workspace default.
	 */
	private async _clearExplicitProject(
		session: positron.LanguageRuntimeSession | undefined
	): Promise<void> {
		await vscode.workspace.getConfiguration('positron.julia')
			.update('languageServer.environmentPath', undefined, vscode.ConfigurationTarget.Workspace);
		this._current = resolveWorkspaceJuliaProject();
		this._updateStatusBar();

		// The language server re-resolves its environment when it restarts
		await vscode.commands.executeCommand('julia.restartLanguageServer');

		if (session) {
			const code = this._current.path
				? `import Pkg; Pkg.activate(${juliaStringLiteral(this._current.path)})`
				: 'import Pkg; Pkg.activate()';
			session.execute(
				code,
				`env-switch-${Date.now()}`,
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue
			);
		}

		LOGGER.info(`Julia environment reset to ${this._current.path ?? 'the global environment'}`);
		this._onDidChangeProject.fire(this._current.path);
	}

	private async _collectProjectFiles(
		dir: string,
		items: EnvQuickPickItem[],
		depth: number
	): Promise<void> {
		if (depth <= 0) {
			return;
		}
		try {
			const projFile = path.join(dir, 'Project.toml');
			const juliaProjFile = path.join(dir, 'JuliaProject.toml');
			if (fs.existsSync(projFile) || fs.existsSync(juliaProjFile)) {
				const name = path.basename(dir);
				items.push({
					label: `$(folder) ${name}`,
					description: dir,
					envPath: dir,
				});
				return; // Don't descend into a project directory
			}

			if (depth > 1) {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
						await this._collectProjectFiles(path.join(dir, entry.name), items, depth - 1);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	}

	private async _switchToPath(
		envPath: string,
		client: JuliaLanguageClient | undefined,
		session: positron.LanguageRuntimeSession | undefined
	): Promise<void> {
		this._current = { path: envPath, explicit: true, reason: 'picked by the user' };
		this._updateStatusBar();

		// Persist the choice as a workspace setting so the LS picks it up on restart
		await vscode.workspace.getConfiguration('positron.julia')
			.update('languageServer.environmentPath', envPath, vscode.ConfigurationTarget.Workspace);

		// Notify the running LS about the new environment
		if (client?.isRunning()) {
			await client.sendLSNotification('julia/activateenvironment', { envPath }).catch(err => {
				LOGGER.warn(`Failed to send environment notification to LS: ${err}`);
			});
		}

		// Activate the new project in the running Julia kernel
		if (session) {
			session.execute(
				`import Pkg; Pkg.activate(${juliaStringLiteral(envPath)})`,
				`env-switch-${Date.now()}`,
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue
			);
			LOGGER.info(`Sent Pkg.activate to running kernel for ${envPath}`);
		}

		LOGGER.info(`Julia environment switched to ${envPath}`);
		this._onDidChangeProject.fire(envPath);
	}

	private _updateStatusBar(): void {
		const project = this._current?.path;
		const name = project ? path.basename(project) : globalEnvironmentName(this._getSession());
		this._statusBarItem.text = `$(julia) ${name}`;
		this._statusBarItem.tooltip = `Julia environment: ${project ?? 'global environment'} — click to change`;
	}

	dispose(): void {
		this._statusBarItem.dispose();
		this._onDidChangeProject.dispose();
	}
}
