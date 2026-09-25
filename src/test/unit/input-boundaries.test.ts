/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the input boundaries Positron uses to run console input and
// Quarto cells one statement at a time. Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';

import { computeJuliaInputBoundaries } from '../../julia-input-boundaries';

/**
 * Boundaries as compact `[start, end, kind]` tuples, after checking that they
 * are contiguous and cover every line (Positron relies on that).
 */
function boundaries(lines: string[], eol = '\n'): [number, number, string][] {
	const result = computeJuliaInputBoundaries(lines.join(eol));
	let next = 0;
	for (const b of result) {
		assert.strictEqual(b.range.start, next, `boundary starts at line ${b.range.start}, expected ${next}`);
		assert.ok(b.range.end > b.range.start, `empty boundary at line ${b.range.start}`);
		next = b.range.end;
	}
	assert.strictEqual(next, lines.length, 'boundaries do not cover every line');
	return result.map(b => [b.range.start, b.range.end, b.kind]);
}

suite('Julia input boundaries', () => {

	test('one input per statement', () => {
		assert.deepStrictEqual(boundaries([
			'x = 1',
			'y = x + 1',
			'error("boom")',
			'z = 3',
		]), [
			[0, 1, 'complete'],
			[1, 2, 'complete'],
			[2, 3, 'complete'],
			[3, 4, 'complete'],
		]);
	});

	test('a multi-line block is one input', () => {
		assert.deepStrictEqual(boundaries([
			'function f(x)',
			'    y = x + 1',
			'    return y',
			'end',
			'f(1)',
		]), [
			[0, 4, 'complete'],
			[4, 5, 'complete'],
		]);
	});

	test('a module is one input, including its body statements', () => {
		assert.deepStrictEqual(boundaries([
			'module M',
			'export g',
			'g() = 1',
			'h() = 2',
			'end',
			'M.g()',
		]), [
			[0, 5, 'complete'],
			[5, 6, 'complete'],
		]);
	});

	test('a nested module stays inside its outer module', () => {
		assert.deepStrictEqual(boundaries([
			'module Outer',
			'module Inner',
			'f() = 1',
			'end',
			'g() = 2',
			'end',
		]), [
			[0, 6, 'complete'],
		]);
	});

	test('blank and comment lines between statements are whitespace', () => {
		assert.deepStrictEqual(boundaries([
			'# setup',
			'x = 1',
			'',
			'# next',
			'y = 2',
			'',
		]), [
			[0, 1, 'whitespace'],
			[1, 2, 'complete'],
			[2, 4, 'whitespace'],
			[4, 5, 'complete'],
			[5, 6, 'whitespace'],
		]);
	});

	test('an unclosed bracket at the end is incomplete', () => {
		assert.deepStrictEqual(boundaries([
			'x = 1',
			'f(a,',
			'  b',
		]), [
			[0, 1, 'complete'],
			[1, 3, 'incomplete'],
		]);
	});

	test('an unclosed block is incomplete', () => {
		assert.deepStrictEqual(boundaries(['function f(x)']), [[0, 1, 'incomplete']]);
	});

	test('an unclosed module is incomplete', () => {
		assert.deepStrictEqual(boundaries(['module M', 'f() = 1']), [[0, 2, 'incomplete']]);
	});

	test('a docstring runs with the definition it documents', () => {
		assert.deepStrictEqual(boundaries([
			'"""',
			'    f(x)',
			'',
			'Adds one.',
			'"""',
			'f(x) = x + 1',
		]), [
			[0, 6, 'complete'],
		]);
	});

	test('`end` inside a triple-quoted string does not close a block', () => {
		assert.deepStrictEqual(boundaries([
			'begin',
			'    s = """',
			'    end',
			'    """',
			'end',
			'x = 1',
		]), [
			[0, 5, 'complete'],
			[5, 6, 'complete'],
		]);
	});

	test('statements joined by `;` across a block end run as one input', () => {
		assert.deepStrictEqual(boundaries([
			'if true',
			'    1',
			'end; y = 2',
			'z = 3',
		]), [
			[0, 3, 'complete'],
			[3, 4, 'complete'],
		]);
	});

	test('code after a module `end` on the same line runs with the module', () => {
		assert.deepStrictEqual(boundaries([
			'module M',
			'f() = 1',
			'end; x = 1',
			'y = 2',
		]), [
			[0, 3, 'complete'],
			[3, 4, 'complete'],
		]);
	});

	test('Windows line endings', () => {
		assert.deepStrictEqual(boundaries([
			'x = 1',
			'for i in 1:2',
			'    println(i)',
			'end',
		], '\r\n'), [
			[0, 1, 'complete'],
			[1, 4, 'complete'],
		]);
	});

	test('empty and whitespace-only input', () => {
		assert.deepStrictEqual(boundaries(['']), [[0, 1, 'whitespace']]);
		assert.deepStrictEqual(boundaries(['', '   ', '# c']), [[0, 3, 'whitespace']]);
	});
});
