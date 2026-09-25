/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Makes new integrated terminals use the same Julia as the console: the
 * foreground Julia session's binary first on PATH, and its project as
 * JULIA_PROJECT. Positron does the same for R (2026.08) and for environment
 * modules (2026.09). Existing terminals are marked stale by VS Code and can be
 * relaunched to pick up a change.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import * as positron from 'positron';

import { JuliaEnvironmentManager } from './environment';
import { LOGGER } from './extension';

const SETTING = 'positron.julia.terminal.useConsoleEnvironment';

export function registerTerminalEnvironment(
	context: vscode.ExtensionContext,
	environmentManager: JuliaEnvironmentManager,
): void {
	const collection = context.environmentVariableCollection;
	// The values follow the live console session, so never restore them from a
	// previous window.
	collection.persistent = false;

	const update = async () => {
		collection.clear();
		if (!vscode.workspace.getConfiguration().get<boolean>(SETTING, true)) {
			return;
		}
		const session = await positron.runtime.getForegroundSession();
		if (session?.runtimeMetadata.languageId !== 'julia') {
			return; // leave R, Python and plain terminals alone
		}

		const bindir = path.dirname(session.runtimeMetadata.runtimePath);
		collection.prepend('PATH', bindir + path.delimiter);
		const project = environmentManager.currentProject;
		if (project) {
			collection.replace('JULIA_PROJECT', project);
		}
		collection.description = `Julia ${session.runtimeMetadata.languageVersion}` +
			(project ? ` and project ${path.basename(project)}` : '') +
			' from the Julia console';
		LOGGER.debug(`Terminal environment: ${bindir} first on PATH, JULIA_PROJECT=${project ?? '(unset)'}`);
	};
	const refresh = () => {
		update().catch(error => LOGGER.warn(`Failed to update the terminal environment: ${error}`));
	};

	context.subscriptions.push(
		positron.runtime.onDidChangeForegroundSession(refresh),
		environmentManager.onDidChangeProject(refresh),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING)) {
				refresh();
			}
		}),
	);
	refresh();
}
