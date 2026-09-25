/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Input boundary provider for Julia (Positron 2026.08+).
 *
 * Positron asks for the boundaries of console input and of Quarto cells (via
 * in-memory documents with language `julia`), then runs the complete inputs
 * one at a time, stopping at the first error. Boundaries come from
 * `julia-input-boundaries.ts`.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

import { computeJuliaInputBoundaries } from './julia-input-boundaries';

export class JuliaInputBoundaryProvider implements positron.InputBoundaryProvider {

	provideInputBoundaries(
		document: vscode.TextDocument,
		range: vscode.Range,
		_token: vscode.CancellationToken,
	): positron.InputBoundary[] {
		return computeJuliaInputBoundaries(document.getText(range));
	}
}

/**
 * Registers the Julia input boundary provider.
 */
export function registerInputBoundaryProvider(
	context: vscode.ExtensionContext,
): vscode.Disposable {
	const disposable = positron.languages.registerInputBoundaryProvider(
		'julia',
		new JuliaInputBoundaryProvider(),
	);
	context.subscriptions.push(disposable);
	return disposable;
}
