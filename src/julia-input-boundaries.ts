/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia input boundaries: how a block of code splits into separately
 * executable inputs. Positron uses them to run multi-statement console input
 * and Quarto cells one statement at a time, and to decide whether console
 * input is complete.
 *
 * Statements come from the lexer in `julia-statements.ts`. Unlike Ctrl+Enter,
 * a `module` block is always a single input: its body cannot run statement by
 * statement at top level.
 *
 * Like `julia-statements.ts`, this module has no dependency on `vscode` or
 * `positron` so it can be unit tested under plain Node.
 */

import { LineRange, segmentJuliaStatements } from './julia-statements';

export type JuliaInputBoundaryKind = 'whitespace' | 'complete' | 'incomplete';

/** Structurally compatible with `positron.InputBoundary`. */
export interface JuliaInputBoundary {
	/** 0-based line range, `end` exclusive, relative to the analyzed text. */
	range: { start: number; end: number };
	kind: JuliaInputBoundaryKind;
}

interface Unit extends LineRange {
	unterminated: boolean;
}

function contains(outer: LineRange, inner: LineRange): boolean {
	return outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
}

/**
 * Splits `text` into input boundaries that together cover every line:
 * statements are `complete` (or `incomplete` when still open at the end), and
 * the blank and comment lines between them are `whitespace`.
 */
export function computeJuliaInputBoundaries(text: string): JuliaInputBoundary[] {
	const lines = text.split(/\r?\n/);
	const { statements, modules } = segmentJuliaStatements(lines);

	// Each outermost module is one input; statements inside it are not.
	const outerModules = modules.filter(m => !modules.some(o => o !== m && contains(o, m)));
	const units: Unit[] = outerModules.map(m => ({ ...m }));
	for (const s of statements) {
		if (!outerModules.some(m => contains(m, s))) {
			units.push({ ...s });
		}
	}
	units.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

	// Inputs are whole lines, so statements sharing a line run together.
	const merged: Unit[] = [];
	for (const unit of units) {
		const last = merged[merged.length - 1];
		if (last && unit.startLine <= last.endLine) {
			last.endLine = Math.max(last.endLine, unit.endLine);
			last.unterminated = last.unterminated || unit.unterminated;
		} else {
			merged.push(unit);
		}
	}

	const boundaries: JuliaInputBoundary[] = [];
	let next = 0;
	for (const unit of merged) {
		if (unit.startLine > next) {
			boundaries.push({ range: { start: next, end: unit.startLine }, kind: 'whitespace' });
		}
		boundaries.push({
			range: { start: unit.startLine, end: unit.endLine + 1 },
			kind: unit.unterminated ? 'incomplete' : 'complete',
		});
		next = unit.endLine + 1;
	}
	if (next < lines.length) {
		boundaries.push({ range: { start: next, end: lines.length }, kind: 'whitespace' });
	}
	return boundaries;
}
