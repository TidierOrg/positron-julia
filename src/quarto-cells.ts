/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';
import { LOGGER } from './extension';

const JULIA_LANGUAGE_ID = 'julia';
const QUARTO_LANGUAGE_ID = 'quarto';

// Opening fence of any fenced block, e.g. ```{julia} or ```julia or ```
const FENCE_OPEN_REGEX = /^\s*(`{3,})(.*)$/;
// Language of an executable Quarto cell, e.g. {julia} or {julia, opts}.
// Deliberately rejects {{julia}} (display-only shortcode syntax).
const CELL_LANGUAGE_REGEX = /^\{\s*([A-Za-z0-9_+.-]+)/;
// Closing fence: backticks only, at least as many as the opening fence
const FENCE_CLOSE_REGEX = /^\s*(`{3,})\s*$/;

interface QuartoCodeCell {
	/** Language of the executable cell, lowercased (e.g. 'julia') */
	languageId: string;
	/** First line of code inside the fences (0-based) */
	codeStartLine: number;
	/** Last line of code inside the fences (0-based, inclusive) */
	codeEndLine: number;
}

/**
 * Find the executable Quarto code cell containing the given line, including
 * its fence lines. Returns undefined for markdown/YAML regions and for
 * display-only code blocks (no `{language}` attribute).
 */
function cellAtLine(document: vscode.TextDocument, line: number): QuartoCodeCell | undefined {
	let open: { fenceLength: number; languageId: string | undefined; startLine: number } | undefined;

	for (let i = 0; i < document.lineCount; i++) {
		const text = document.lineAt(i).text;
		if (!open) {
			const match = FENCE_OPEN_REGEX.exec(text);
			if (match) {
				const languageMatch = CELL_LANGUAGE_REGEX.exec(match[2].trim());
				open = {
					fenceLength: match[1].length,
					languageId: languageMatch?.[1]?.toLowerCase(),
					startLine: i,
				};
			}
			continue;
		}

		const close = FENCE_CLOSE_REGEX.exec(text);
		if (close && close[1].length >= open.fenceLength) {
			if (line >= open.startLine && line <= i) {
				return open.languageId
					? { languageId: open.languageId, codeStartLine: open.startLine + 1, codeEndLine: i - 1 }
					: undefined;
			}
			open = undefined;
		}
	}

	// Unterminated cell at the end of the document
	if (open?.languageId && line >= open.startLine) {
		return {
			languageId: open.languageId,
			codeStartLine: open.startLine + 1,
			codeEndLine: document.lineCount - 1,
		};
	}
	return undefined;
}

async function runFallbackCommand(command: string): Promise<void> {
	try {
		await vscode.commands.executeCommand(command);
	} catch (error) {
		LOGGER.warn(`Failed to run fallback command '${command}': ${error}`);
	}
}

interface ExecuteQuartoCellArgs {
	/**
	 * 'statement' (default) runs the statement or selection at the cursor and
	 * advances, like Cmd+Enter in Python/R cells. 'cell' runs the whole cell,
	 * like the cell "Run" button.
	 */
	scope?: 'statement' | 'cell';
	/** Command to delegate to for non-Julia cells and non-cell regions. */
	fallbackCommand?: string;
}

/**
 * Run Julia code at the cursor of a Quarto document through Positron's
 * per-document Quarto session, with inline output. Non-Julia cells (and
 * cursors outside any cell) are delegated to the Quarto extension's own
 * command so Python/R behavior is unchanged.
 */
async function executeQuartoCell(args?: ExecuteQuartoCellArgs): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const scope = args?.scope ?? 'statement';
	const fallbackCommand = args?.fallbackCommand ?? 'quarto.runCurrent';
	const document = editor.document;
	if (document.languageId !== QUARTO_LANGUAGE_ID) {
		await runFallbackCommand(fallbackCommand);
		return;
	}

	const cell = cellAtLine(document, editor.selection.active.line);
	if (!cell || cell.languageId !== JULIA_LANGUAGE_ID) {
		await runFallbackCommand(fallbackCommand);
		return;
	}

	if (scope === 'statement') {
		// The same route Python/R cells take: Positron resolves the statement
		// at the cursor (or the selection), runs it in the document's Quarto
		// session with inline output, and advances to the next statement. The
		// statement range comes from this extension's provider, reached
		// through the Quarto extension's virtual Julia document.
		await vscode.commands.executeCommand(
			'workbench.action.positronConsole.executeCode',
			{ languageId: JULIA_LANGUAGE_ID },
		);
		return;
	}

	if (cell.codeEndLine < cell.codeStartLine) {
		return;
	}
	const codeRange = new vscode.Range(
		cell.codeStartLine,
		0,
		cell.codeEndLine,
		document.lineAt(cell.codeEndLine).text.length,
	);

	if (typeof positron.runtime.executeInlineCell === 'function') {
		await positron.runtime.executeInlineCell(document.uri, [codeRange]);
		return;
	}

	// Positron builds without per-document Quarto sessions: fall back to the
	// Julia console.
	const code = document.getText(codeRange).trim();
	if (!code) {
		return;
	}
	await positron.runtime.executeCode(
		JULIA_LANGUAGE_ID,
		code,
		false,
		false,
		positron.RuntimeCodeExecutionMode.Interactive,
		positron.RuntimeErrorBehavior.Continue,
	);
}

export function registerQuartoCellCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'julia.executeQuartoCell',
			(args?: ExecuteQuartoCellArgs) => executeQuartoCell(args),
		),
	);
}
