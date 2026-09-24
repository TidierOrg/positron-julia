/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Statement range provider for Julia.
 *
 * Ctrl+Enter / Cmd+Enter sends the whole statement containing the cursor to
 * the console and advances to the next one. The cursor can be on any line of
 * the statement: the first line, a continuation line of a multi-line call
 * (issue #39), a line inside a block, or the block's closing `end`. On a blank
 * or comment line, the next statement is sent.
 *
 * Statement boundaries come from the lexer in `julia-statements.ts`.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

import {
	findJuliaStatementAt,
	JuliaSegmentation,
	LineRange,
	segmentJuliaStatements,
} from './julia-statements';

/**
 * Segmentation of the most recently queried document. Positron asks for two
 * ranges per Cmd+Enter (the statement, then the next one to advance to) on the
 * same text, so this saves re-lexing the document.
 */
let cache: { lines: string[]; segmentation: JuliaSegmentation } | undefined;

function documentLines(document: vscode.TextDocument): string[] {
	const lines = new Array<string>(document.lineCount);
	for (let i = 0; i < document.lineCount; i++) {
		lines[i] = document.lineAt(i).text;
	}
	return lines;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * Line range of the Julia statement to run for a cursor on `line`: the
 * statement containing it, or else the next statement below it.
 */
export function juliaStatementAt(document: vscode.TextDocument, line: number): LineRange | undefined {
	const lines = documentLines(document);
	if (!cache || !sameLines(cache.lines, lines)) {
		cache = { lines, segmentation: segmentJuliaStatements(lines) };
	}
	return findJuliaStatementAt(cache.lines, line, cache.segmentation);
}

/** Full-line document range covering `lines`. */
export function statementDocumentRange(document: vscode.TextDocument, lines: LineRange): vscode.Range {
	return new vscode.Range(
		lines.startLine, 0,
		lines.endLine, document.lineAt(lines.endLine).text.length,
	);
}

// ── Main provider ───────────────────────────────────────────────────────

export class JuliaStatementRangeProvider implements positron.StatementRangeProvider {

	provideStatementRange(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): positron.StatementRange | undefined {
		const lines = juliaStatementAt(document, position.line);
		if (!lines) {
			return undefined; // no code at or below the cursor
		}

		const range = statementDocumentRange(document, lines);

		// For multiline statements, append a trailing newline so the REPL
		// processes the code correctly.
		if (lines.startLine !== lines.endLine) {
			return { range, code: document.getText(range) + '\n' };
		}
		return { range };
	}
}

/**
 * Registers the Julia statement range provider.
 */
export function registerStatementRangeProvider(
	context: vscode.ExtensionContext,
): vscode.Disposable {
	const provider = new JuliaStatementRangeProvider();
	const disposable = positron.languages.registerStatementRangeProvider(
		'julia',
		provider,
	);
	context.subscriptions.push(disposable);
	return disposable;
}
