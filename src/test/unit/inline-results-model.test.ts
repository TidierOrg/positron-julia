/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the inline results helpers (issue #40).
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';

import {
	adjustRangeForEdit,
	executedLineRange,
	previewText,
	stripAnsi,
	truncateText,
} from '../../inline-results-model';

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
	return {
		start: { line: startLine, character: startCharacter },
		end: { line: endLine, character: endCharacter },
	};
}

suite('Inline results: executed lines', () => {
	test('a statement range covers its lines', () => {
		assert.deepStrictEqual(executedLineRange(range(5, 0, 6, 15)), { startLine: 5, endLine: 6 });
		assert.deepStrictEqual(executedLineRange(range(3, 0, 3, 16)), { startLine: 3, endLine: 3 });
	});

	test('a selection ending at the start of a line excludes that line', () => {
		assert.deepStrictEqual(executedLineRange(range(2, 0, 5, 0)), { startLine: 2, endLine: 4 });
	});

	test('an empty range has no lines', () => {
		assert.strictEqual(executedLineRange(range(0, 0, 0, 0)), undefined);
	});
});

suite('Inline results: following edits', () => {
	const marked = { startLine: 10, endLine: 12 };

	test('edits below the marked lines leave them alone', () => {
		const change = { range: range(20, 0, 20, 0), text: 'x = 1\n' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, change), marked);
	});

	test('lines added or removed above shift the marked lines', () => {
		const added = { range: range(2, 4, 2, 4), text: '\n\n' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, added), { startLine: 12, endLine: 14 });

		const removed = { range: range(3, 0, 6, 0), text: '' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, removed), { startLine: 7, endLine: 9 });
	});

	test('whole lines inserted right above the marked lines shift them', () => {
		const change = { range: range(10, 0, 10, 0), text: 'using Foo\n' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, change), { startLine: 11, endLine: 13 });
	});

	test('editing the marked code removes the mark', () => {
		const typed = { range: range(11, 4, 11, 4), text: 'a' };
		assert.strictEqual(adjustRangeForEdit(marked, typed), undefined);

		const typedAtEnd = { range: range(12, 7, 12, 7), text: ' + 1' };
		assert.strictEqual(adjustRangeForEdit(marked, typedAtEnd), undefined);

		const joined = { range: range(9, 5, 10, 0), text: '' };
		assert.strictEqual(adjustRangeForEdit(marked, joined), undefined);
	});

	test('pressing Enter at the end of the last marked line keeps the mark', () => {
		// Line 12 was "    y = 2)" (10 characters); Enter adds an indented line.
		const lineTextAfter = (line: number) => (line === 12 ? '    y = 2)' : line === 13 ? '    ' : undefined);
		const change = { range: range(12, 10, 12, 10), text: '\n    ' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, change, lineTextAfter), marked);
	});

	test('Positron appending a final newline after the last statement keeps the mark', () => {
		const lineTextAfter = (line: number) => (line === 13 ? '' : 'code');
		const change = { range: range(12, 4, 12, 4), text: '\n' };
		assert.deepStrictEqual(adjustRangeForEdit(marked, change, lineTextAfter), marked);
	});

	test('splitting the last marked line removes the mark', () => {
		// Enter in the middle: the rest of the line moves down.
		const lineTextAfter = (line: number) => (line === 13 ? '2)' : undefined);
		const change = { range: range(12, 8, 12, 8), text: '\n' };
		assert.strictEqual(adjustRangeForEdit(marked, change, lineTextAfter), undefined);
	});

	test('without line text, a newline at the end is treated as an edit', () => {
		const change = { range: range(12, 10, 12, 10), text: '\n' };
		assert.strictEqual(adjustRangeForEdit(marked, change), undefined);
	});
});

suite('Inline results: previews', () => {
	test('the first line of a value', () => {
		assert.strictEqual(previewText('1×2 DataFrame\n Row │ x      y\n', 80), '1×2 DataFrame');
		assert.strictEqual(previewText('42', 80), '42');
	});

	test('a header line loses its trailing colon', () => {
		assert.strictEqual(previewText('3-element Vector{Int64}:\n 1\n 2\n 3', 80), '3-element Vector{Int64}');
		assert.strictEqual(previewText('Dict(:a => 1):', 80), 'Dict(:a => 1):');
	});

	test('leading blank lines are skipped', () => {
		assert.strictEqual(previewText('\n\n  UndefVarError: `y` not defined\n', 80), 'UndefVarError: `y` not defined');
	});

	test('long lines are cut with an ellipsis', () => {
		const preview = previewText('x'.repeat(100), 10);
		assert.strictEqual(preview, 'xxxxxxxxx…');
		assert.strictEqual(Array.from(previewText('α'.repeat(20), 5)).length, 5);
	});

	test('ANSI escape sequences are removed', () => {
		assert.strictEqual(stripAnsi('\x1b[31mERROR\x1b[0m: boom'), 'ERROR: boom');
		assert.strictEqual(previewText('\x1b[1m\x1b[32m3\x1b[0m', 80), '3');
	});

	test('empty output has no preview', () => {
		assert.strictEqual(previewText('', 80), '');
		assert.strictEqual(previewText('  \n ', 80), '');
	});

	test('hover text is cut at a line boundary', () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
		const cut = truncateText(text, 30);
		assert.ok(cut.endsWith('\n…'), cut);
		assert.ok(cut.length < 40, cut);
		assert.strictEqual(truncateText('short', 30), 'short');
	});
});
