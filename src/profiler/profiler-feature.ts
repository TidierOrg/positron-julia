/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia profiler (issue #14). `@profview expr` in the Julia console profiles
 * `expr` and opens a one-shot `positron.profile` comm whose open data is the
 * profile (see `julia/Positron/src/profile.jl`). This extension claims those
 * comms, keeps the last profiles, and shows them as a flame graph.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER } from '../extension';
import { juliaStatementAt, statementDocumentRange } from '../statement-range';
import { isProfile, ProfileStore } from './profile-store';
import { ProfilerPanel } from './profiler-panel';

const HAS_PROFILES = 'julia.hasProfiles';

export function registerProfiler(context: vscode.ExtensionContext): void {
	const store = new ProfileStore();
	const panel = new ProfilerPanel(context.extensionUri);

	const show = async () => {
		await vscode.commands.executeCommand('setContext', HAS_PROFILES, store.count > 0);
		const title = store.count > 0
			? `Julia Profile ${store.currentIndex + 1} of ${store.count}`
			: 'Julia Profile';
		await panel.show(store.current, title);
	};
	const showSafely = () => {
		show().catch(error => LOGGER.warn(`Failed to show the Julia profile: ${error}`));
	};

	context.subscriptions.push(
		panel,
		positron.runtime.registerClientHandler({
			clientType: 'positron.profile',
			callback: (client, params) => {
				if (isProfile(params)) {
					store.add(params);
					showSafely();
				} else {
					LOGGER.warn('Ignoring a malformed profile from the Julia kernel');
				}
				// One-shot: closing the comm frees it in the kernel.
				setImmediate(() => client.dispose());
				return true;
			},
		}),

		vscode.commands.registerCommand('julia.openProfiler', showSafely),
		vscode.commands.registerCommand('julia.nextProfile', () => {
			if (store.move(1)) { showSafely(); }
		}),
		vscode.commands.registerCommand('julia.previousProfile', () => {
			if (store.move(-1)) { showSafely(); }
		}),
		vscode.commands.registerCommand('julia.deleteProfile', () => {
			store.deleteCurrent();
			showSafely();
		}),
		vscode.commands.registerCommand('julia.deleteAllProfiles', async () => {
			if (store.count === 0) {
				return;
			}
			const deleteAll = 'Delete All';
			const answer = await vscode.window.showWarningMessage(
				`Delete all ${store.count} Julia profiles?`, { modal: true }, deleteAll);
			if (answer === deleteAll) {
				store.clear();
				showSafely();
			}
		}),
		vscode.commands.registerCommand('julia.profileSelection', profileSelection),
	);
}

/**
 * Profiles the editor selection, or else the statement at the cursor, in the
 * Julia console.
 */
async function profileSelection(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'julia') {
		vscode.window.showWarningMessage('Select Julia code in an editor to profile it.');
		return;
	}
	let code = editor.document.getText(editor.selection);
	if (!code.trim()) {
		const statement = juliaStatementAt(editor.document, editor.selection.active.line);
		code = statement ? editor.document.getText(statementDocumentRange(editor.document, statement)) : '';
	}
	if (!code.trim()) {
		vscode.window.showWarningMessage('No Julia code to profile at the cursor.');
		return;
	}
	await positron.runtime.executeCode('julia', `Positron.@profview begin\n${code}\nend`, true);
}
