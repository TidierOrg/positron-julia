/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime completion provider for Julia.
 *
 * Uses Julia's REPL.completions via positron.runtime.executeCode (Silent mode)
 * so the query is fully invisible — no console output, no history entry.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';
import { LOGGER } from './extension';

/**
 * Escape a string for embedding as a Julia double-quoted string literal.
 */
function escapeForJulia(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Build the Julia snippet that runs REPL.completions and prints results to
 * stdout in the form:
 *   <cursor_start_0indexed>\n<match1>\n<match2>\n...
 *
 * All output is captured via ExecutionObserver.onOutput; nothing reaches the
 * user's console.
 */
function buildCompletionSnippet(query: string): string {
	const escaped = escapeForJulia(query);
	const cursorPos = query.length;
	// Single-line so it's easy to pass to executeCode. The try/catch prevents
	// any error (e.g. incomplete input) from propagating to the user.
	return (
		`try; import REPL; ` +
		`local cs, range, _ = REPL.completions("${escaped}", ${cursorPos}); ` +
		`print(first(range) - 1); ` +
		`foreach(c -> print("\\n", REPL.completion_text(c)), cs); ` +
		`catch; end`
	);
}

/**
 * Parse the stdout produced by buildCompletionSnippet into a ReplCompletionResult.
 */
function parseCompletionOutput(stdout: string, queryLength: number): ReplCompletionResult | null {
	const lines = stdout.trim().split('\n');
	if (!lines[0]) {
		return null;
	}
	const cursor_start = parseInt(lines[0], 10);
	const matches = lines.slice(1).filter(s => s.length > 0);
	if (matches.length === 0) {
		return null;
	}
	return {
		matches,
		cursor_start: isNaN(cursor_start) ? 0 : cursor_start,
		cursor_end: queryLength,
	};
}

/**
 * Provides runtime completions for Julia by querying the active Julia session.
 * This supplements the LSP completions with variables and functions defined in the current session.
 */
export class JuliaRuntimeCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[] | undefined> {

		if (document.languageId !== 'julia') {
			return undefined;
		}

		const lineText = document.lineAt(position.line).text;
		const query = lineText.substring(0, position.character);

		if (!query.trim()) {
			return undefined;
		}

		// Don't start a new Julia session just for completions.
		const sessions = await positron.runtime.getActiveSessions();
		const hasJuliaSession = sessions.some(s => s.runtimeMetadata.languageId === 'julia');
		if (!hasJuliaSession) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			let stdout = '';
			await positron.runtime.executeCode(
				'julia',
				buildCompletionSnippet(query),
				false,   // don't steal focus
				false,   // don't allow incomplete
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue,
				{ token, onOutput: (msg: string) => { stdout += msg; } }
			);

			if (token.isCancellationRequested) {
				return undefined;
			}

			const result = parseCompletionOutput(stdout, query.length);
			if (!result || result.matches.length === 0) {
				return undefined;
			}

			const replaceRange = new vscode.Range(
				position.line, result.cursor_start,
				position.line, position.character
			);

			return result.matches.map(text => {
				const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Variable);
				item.range = replaceRange;
				item.sortText = ` ${text}`; // space prefix sorts runtime items before LSP items
				item.detail = '(runtime)';
				return item;
			});
		} catch (err) {
			LOGGER.warn(`Runtime completion error: ${err}`);
			return undefined;
		}
	}

	dispose(): void {
		// nothing to clean up
	}
}

/**
 * Registers the Julia runtime completion provider.
 */
export function registerCompletionProvider(context: vscode.ExtensionContext): vscode.Disposable {
	const provider = new JuliaRuntimeCompletionProvider();

	const disposable = vscode.languages.registerCompletionItemProvider(
		[
			{ language: 'julia', scheme: 'file' },
			{ language: 'julia', scheme: 'untitled' },
			{ language: 'julia', scheme: 'inmemory' },
		],
		provider,
		'.', // trigger on dot for field/module member completion
	);

	context.subscriptions.push(disposable);
	context.subscriptions.push(provider);

	LOGGER.info('Julia runtime completion provider registered');

	return disposable;
}

export interface ReplCompletionResult {
	matches: string[];
	cursor_start: number;
	cursor_end: number;
}

/**
 * Queries the active Julia runtime session for completions.
 * Used to bridge Language Server completions with the REPL session.
 * Returns null when no session is available or the query is empty.
 */
export async function getRuntimeCompletions(query: string): Promise<ReplCompletionResult | null> {
	if (!query || !query.trim()) {
		return null;
	}

	// Don't start a new Julia session just for completions.
	const sessions = await positron.runtime.getActiveSessions();
	const hasJuliaSession = sessions.some(s => s.runtimeMetadata.languageId === 'julia');
	if (!hasJuliaSession) {
		return null;
	}

	try {
		let stdout = '';
		await positron.runtime.executeCode(
			'julia',
			buildCompletionSnippet(query),
			false,
			false,
			positron.RuntimeCodeExecutionMode.Silent,
			positron.RuntimeErrorBehavior.Continue,
			{ onOutput: (msg: string) => { stdout += msg; } }
		);

		return parseCompletionOutput(stdout, query.length);
	} catch (err) {
		LOGGER.warn(`Runtime completion error in getRuntimeCompletions: ${err}`);
		return null;
	}
}
