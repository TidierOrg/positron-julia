/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for inline execution results (issue #40): which lines a
 * submission covers, how a mark follows edits, and the one-line preview shown
 * next to it. No `vscode` dependency, so they can be unit tested under Node.
 */

import { LineRange } from './julia-statements';

export { LineRange };

interface Position {
	readonly line: number;
	readonly character: number;
}

interface Range {
	readonly start: Position;
	readonly end: Position;
}

/** The shape of a `vscode.TextDocumentContentChangeEvent`. */
export interface TextChange {
	readonly range: Range;
	readonly text: string;
}

/**
 * Lines covered by an executed range. A multi-line selection that ends at the
 * start of a line does not include that line. Returns undefined for an empty
 * range (Positron sends 0:0-0:0 when it only knows the document).
 */
export function executedLineRange(range: Range): LineRange | undefined {
	const { start, end } = range;
	if (start.line === end.line && start.character === end.character) {
		return undefined;
	}
	let endLine = end.line;
	if (end.character === 0 && end.line > start.line) {
		endLine--;
	}
	return { startLine: start.line, endLine };
}

function lineBreakCount(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			count++;
		}
	}
	return count;
}

/**
 * Where a marked line range ends up after an edit: shifted when lines are
 * added or removed above it, unchanged when the edit is below it, and
 * undefined when the edit touches the marked code itself.
 *
 * @param lineTextAfter Text of a line after the edit. When given, lines
 *  inserted right after the last marked line (pressing Enter at its end, or
 *  Positron adding a final newline when advancing) keep the mark.
 */
export function adjustRangeForEdit(
	lines: LineRange,
	change: TextChange,
	lineTextAfter?: (line: number) => string | undefined,
): LineRange | undefined {
	const { start, end } = change.range;
	const insertedBreaks = lineBreakCount(change.text);
	const delta = insertedBreaks - (end.line - start.line);

	if (start.line > lines.endLine) {
		return lines;
	}
	if (end.line < lines.startLine) {
		return { startLine: lines.startLine + delta, endLine: lines.endLine + delta };
	}

	const isInsertion = start.line === end.line && start.character === end.character;
	if (isInsertion && insertedBreaks > 0) {
		// Whole lines inserted above the first marked line.
		if (start.line === lines.startLine && start.character === 0 && change.text.endsWith('\n')) {
			return { startLine: lines.startLine + delta, endLine: lines.endLine + delta };
		}
		// New lines started at the very end of the last marked line.
		if (start.line === lines.endLine && /^\r?\n/.test(change.text) && lineTextAfter) {
			const lastInserted = change.text.substring(change.text.lastIndexOf('\n') + 1);
			if (lineTextAfter(start.line + insertedBreaks) === lastInserted) {
				return lines;
			}
		}
	}
	return undefined;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Removes ANSI color and control sequences. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, '');
}

/**
 * One-line preview of a result or error: its first non-blank line, without a
 * trailing `:` header marker (`3-element Vector{Int64}:`), cut to `maxLength`
 * characters.
 */
export function previewText(text: string, maxLength: number): string {
	const lines = stripAnsi(text).split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	if (lines.length === 0) {
		return '';
	}
	let first = lines[0];
	if (lines.length > 1 && first.endsWith(':')) {
		first = first.slice(0, -1);
	}
	const chars = Array.from(first);
	if (chars.length > maxLength) {
		first = chars.slice(0, maxLength - 1).join('') + '…';
	}
	return first;
}

/** `text` cut to about `maxLength` characters, marking the cut. */
export function truncateText(text: string, maxLength: number): string {
	const clean = stripAnsi(text).replace(/\s+$/, '');
	if (clean.length <= maxLength) {
		return clean;
	}
	return clean.substring(0, maxLength).replace(/\n[^\n]*$/, '') + '\n…';
}
