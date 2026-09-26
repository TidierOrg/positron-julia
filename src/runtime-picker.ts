/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia items in Positron's Start Session picker, like Python's "Install
 * Python via uv": install Julia through juliaup when it is missing, and start
 * the console in a chosen project environment.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as positron from 'positron';

import { juliaupDirectory } from './julia-discovery';
import { JuliaRuntimeManager } from './runtime-manager';
import { createJuliaRuntimeMetadata } from './runtime';

const INSTALL_JULIAUP = 'julia.installJuliaup';
const ACTIVATE_PROJECT = 'julia.activateProjectEnvironment';

/** The official juliaup installers (https://github.com/JuliaLang/juliaup). */
function juliaupInstallCommand(): string {
	return process.platform === 'win32'
		? 'winget install --name Julia --id 9NJNWW8PVKMN -e -s msstore'
		: 'curl -fsSL https://install.julialang.org | sh';
}

function isJuliaupInstalled(): boolean {
	return fs.existsSync(path.join(juliaupDirectory(), 'juliaup.json'));
}

export function registerRuntimePicker(
	context: vscode.ExtensionContext,
	runtimeManager: JuliaRuntimeManager,
): void {
	context.subscriptions.push(positron.runtime.registerRuntimePickerContribution({
		languageId: 'julia',

		async getItems(): Promise<positron.runtime.RuntimePickerItem[]> {
			const items: positron.runtime.RuntimePickerItem[] = [];
			if (!isJuliaupInstalled()) {
				items.push({
					id: INSTALL_JULIAUP,
					label: '$(cloud-download) Install Julia via juliaup',
					detail: `Runs the official installer in a terminal: ${juliaupInstallCommand()}`,
					separatorLabel: 'Julia',
				});
			}
			if (vscode.workspace.workspaceFolders?.length) {
				items.push({
					id: ACTIVATE_PROJECT,
					label: '$(folder-library) Activate Julia Project Environment…',
					detail: 'Choose the project the Julia console uses',
					separatorLabel: items.length === 0 ? 'Julia' : undefined,
				});
			}
			return items;
		},

		async onDidSelectItem(itemId: string): Promise<string | undefined> {
			if (itemId === INSTALL_JULIAUP) {
				const terminal = vscode.window.createTerminal({ name: 'Install juliaup' });
				terminal.show();
				// Typed into a visible terminal: the installer asks the user to
				// confirm before changing anything.
				terminal.sendText(juliaupInstallCommand());
				const discover = 'Discover Interpreters';
				vscode.window.showInformationMessage(
					'When the juliaup installer finishes, discover interpreters to add Julia to Positron.',
					discover,
				).then(choice => {
					if (choice === discover) {
						vscode.commands.executeCommand('workbench.action.language.runtime.discoverAllRuntimes');
					}
				});
				return undefined;
			}

			if (itemId === ACTIVATE_PROJECT) {
				const picked = await vscode.commands.executeCommand<boolean>('julia.changeCurrentEnvironment');
				// A running console switches project in place; otherwise start one.
				if (!picked || runtimeManager.getActiveJuliaSession()) {
					return undefined;
				}
				const installation = await runtimeManager.getPreferredInstallation();
				return installation
					? createJuliaRuntimeMetadata(installation, context.extensionPath).runtimeId
					: undefined;
			}
			return undefined;
		},
	}));
}
