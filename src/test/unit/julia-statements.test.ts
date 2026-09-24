/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the Julia statement lexer behind Ctrl+Enter / Cmd+Enter.
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';

import { findJuliaStatementAt, segmentJuliaStatements } from '../../julia-statements';

/** [startLine, endLine] of the statement to run for a cursor on `line`. */
function at(lines: string[], line: number): [number, number] | undefined {
	const range = findJuliaStatementAt(lines, line);
	return range ? [range.startLine, range.endLine] : undefined;
}

/** Asserts the statement for every cursor line in `cursorLines`. */
function expectStatement(lines: string[], cursorLines: number[], expected: [number, number] | undefined): void {
	for (const line of cursorLines) {
		assert.deepStrictEqual(at(lines, line), expected, `cursor on line ${line}: ${JSON.stringify(lines[line])}`);
	}
}

/** Top-level statement ranges of `lines`. */
function statements(lines: string[]): [number, number][] {
	return segmentJuliaStatements(lines).statements.map(s => [s.startLine, s.endLine]);
}

suite('Julia statements: multi-line calls (issue #39)', () => {
	const script = [
		'import Pkg',                 // 0
		'Pkg.activate(".")',          // 1
		'Pkg.add("DataFrames")',      // 2
		'using DataFrames',           // 3
		'',                           // 4
		'DataFrame(x = 1, ',          // 5
		'          y = 2)',           // 6
		'',                           // 7
	];

	test('runs the whole call from its first line', () => {
		expectStatement(script, [5], [5, 6]);
	});

	test('runs the whole call from its continuation line', () => {
		expectStatement(script, [6], [5, 6]);
	});

	test('runs single-line statements on their own', () => {
		expectStatement(script, [0], [0, 0]);
		expectStatement(script, [3], [3, 3]);
	});

	test('a blank line runs the next statement', () => {
		expectStatement(script, [4], [5, 6]);
	});

	test('nothing to run below the last statement', () => {
		expectStatement(script, [7], undefined);
	});

	test('nested multi-line calls', () => {
		const lines = [
			'df = transform(',
			'    groupby(df, :g),',
			'    :x => (x -> x .+ 1) => :y,',
			')',
			'z = 1',
		];
		expectStatement(lines, [0, 1, 2, 3], [0, 3]);
		expectStatement(lines, [4], [4, 4]);
	});
});

suite('Julia statements: blocks', () => {
	test('any line of a function runs the whole function', () => {
		const lines = [
			'function f(x)',
			'    y = x + 1',
			'',
			'    return y',
			'end',
			'f(1)',
		];
		expectStatement(lines, [0, 1, 2, 3, 4], [0, 4]);
		expectStatement(lines, [5], [5, 5]);
	});

	test('nested blocks run as one top-level statement', () => {
		const lines = [
			'for i in 1:3',
			'    if isodd(i)',
			'        println(i)',
			'    else',
			'        while false',
			'        end',
			'    end',
			'end',
			'x = 1',
		];
		expectStatement(lines, [0, 1, 2, 3, 4, 5, 6, 7], [0, 7]);
		expectStatement(lines, [8], [8, 8]);
	});

	test('every block keyword is matched by its end', () => {
		const lines = [
			'let a = 1',
			'end',
			'begin',
			'end',
			'try',
			'    error()',
			'catch e',
			'finally',
			'end',
			'struct S',
			'    x::Int',
			'end',
			'mutable struct M',
			'end',
			'abstract type A end',
			'primitive type P 8 end',
			'macro m(ex)',
			'    quote',
			'        $(esc(ex))',
			'    end',
			'end',
			'while false',
			'end',
			'map(1:3) do x',
			'    x',
			'end',
		];
		assert.deepStrictEqual(statements(lines), [
			[0, 1], [2, 3], [4, 8], [9, 11], [12, 13], [14, 14], [15, 15], [16, 20], [21, 22], [23, 25],
		]);
	});

	test('one-line blocks', () => {
		const lines = ['if x; y; end', 'for i in 1:3 println(i) end', 'z = 1'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2]]);
	});

	test('macro-prefixed blocks', () => {
		const lines = [
			'@testset "math" begin',
			'    @test 1 + 1 == 2',
			'end',
			'@inbounds for i in eachindex(x)',
			'    x[i] = 0',
			'end',
			'@static if Sys.iswindows()',
			'    const SEP = "\\\\"',
			'end',
		];
		assert.deepStrictEqual(statements(lines), [[0, 2], [3, 5], [6, 8]]);
	});

	test('block expressions used as values', () => {
		const lines = [
			'y = if a',
			'    1',
			'else',
			'    2',
			'end',
			'f = function (x)',
			'    x',
			'end',
			'g = x -> begin',
			'    x',
			'end',
		];
		assert.deepStrictEqual(statements(lines), [[0, 4], [5, 7], [8, 10]]);
	});

	test('keyword-like identifiers are not keywords', () => {
		const lines = [
			'endpoint = 1',
			'forλ = 2',
			'ifelse_ = 3',
			'x.type = 4',
			'type = 5',
			'ends_with!(x) = 6',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
	});

	test('quoted symbols are not keywords', () => {
		const lines = [
			'ex = Expr(:if, cond, body)',
			'h = :end',
			'k = ex.head === :function',
			'z = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3]]);
	});
});

suite('Julia statements: indexing, comprehensions and generators', () => {
	test('`end` and `begin` inside brackets are indices', () => {
		const lines = [
			'function last2(x)',
			'    a = x[end]',
			'    b = x[begin]',
			'    c = x[(begin + 1):(end - 1)]',
			'    return x[end-1:end]',
			'end',
			'y = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 5], [6, 6]]);
	});

	test('comprehensions and generators do not open blocks', () => {
		const lines = [
			'ys = [x^2 for x in 1:10]',
			'zs = [x for x in xs if iseven(x)]',
			's = sum(x for x in xs if x > 0)',
			'd = Dict(k => v for (k, v) in pairs(nt))',
			'm = [i + j for i in 1:3, j in 1:3]',
			'w = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
	});

	test('multi-line comprehension', () => {
		const lines = [
			'ys = [',
			'    f(x)',
			'    for x in xs',
			'    if x > 0',
			']',
			'z = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 4], [5, 5]]);
	});

	test('if-expression and blocks inside parentheses', () => {
		const lines = [
			'function f(a)',
			'    y = (if a 1 else 2 end)',
			'    z = (begin; 3; end)',
			'    return foo(function (x) x end, y)',
			'end',
			'w = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 4], [5, 5]]);
	});

	test('let block inside a comprehension', () => {
		const lines = ['v = [let y = 2x; y end for x in 1:3]', 'w = 1'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1]]);
	});
});

suite('Julia statements: continuation lines', () => {
	test('trailing binary operators continue the statement', () => {
		const lines = [
			'total = a +',
			'    b',
			'result = df |>',
			'    filter(r -> r.x > 1) |>',
			'    collect',
			'x =',
			'    1',
			'ok = a &&',
			'    b',
			'y = c ?',
			'    d :',
			'    e',
			'n = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 1], [2, 4], [5, 6], [7, 8], [9, 11], [12, 12]]);
		expectStatement(lines, [3], [2, 4]);
	});

	test('a trailing comma continues the statement', () => {
		const lines = ['a, b =', '    1, 2', 'using Foo,', '    Bar', 'x = 1'];
		assert.deepStrictEqual(statements(lines), [[0, 1], [2, 3], [4, 4]]);
	});

	test('blank and comment lines after a trailing operator stay in the statement', () => {
		const lines = ['x = 1 +', '', '# note', '    2', 'y = 3'];
		assert.deepStrictEqual(statements(lines), [[0, 3], [4, 4]]);
	});

	test('operators used as names do not continue the statement', () => {
		const lines = [
			'import Base: +, -, *',
			'using LinearAlgebra: ⋅',
			'op = :+',
			'mul = Base.:*',
			'x = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
	});

	test('postfix operators and literals do not continue the statement', () => {
		const lines = [
			"B = A'",
			'f(args...) = g(args...)',
			'x = 1.',
			'msg = name * "!"',
			"c = '+'",
			'y = 2',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
	});

	test('a line starting with an operator is its own statement', () => {
		// Julia does not join a line that *starts* with an operator.
		const lines = ['x = 1', '    + 2'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1]]);
	});
});

suite('Julia statements: strings and comments', () => {
	test('brackets, keywords and operators inside strings are ignored', () => {
		const lines = [
			'a = "unclosed ( [ { for if function"',
			'b = "ends with +"',
			'c = "has # no comment"',
			'd = raw"C:\\path\\\\"', // a raw string ending in a backslash
			'e = r"^\\s*$"',
			'f = `echo (`',
			'g = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]);
	});

	test('escaped quotes do not end a string', () => {
		const lines = ['s = "say \\"hi\\" ("', 'x = 1'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1]]);
	});

	test('interpolation with nested strings and parentheses', () => {
		const lines = [
			'println("a $(join(xs, ")")) b")',
			'println("n = $(length("((("))")',
			'x = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2]]);
	});

	test('triple-quoted and multi-line strings', () => {
		const lines = [
			's = """',
			'    function (',
			'    end end',
			'    """',
			't = "line one',
			'line two"',
			'u = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 3], [4, 5], [6, 6]]);
		expectStatement(lines, [1, 2], [0, 3]);
	});

	test('char literals vs. the adjoint operator', () => {
		const lines = [
			"open = '('",
			"close = ')'",
			"quote_ = '\"'",
			"hash = '#'",
			"esc = '\\''",
			"uni = '\\u2200'",
			"t = x' * y'",
			'z = 1',
		];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]);
	});

	test('block comments, including nested ones, are not code', () => {
		const lines = [
			'#=',
			'for each item (',
			'  #= nested =#',
			'=#',
			'x = 1',
			'y = 2 #= trailing',
			'comment =#',
			'z = 3',
		];
		assert.deepStrictEqual(statements(lines), [[4, 4], [5, 6], [7, 7]]);
		expectStatement(lines, [0, 1, 2, 3], [4, 4]);
	});

	test('line comments with keywords and brackets are ignored', () => {
		const lines = ['x = 1 # for ( function', '# if [', 'y = 2'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [2, 2]]);
	});
});

suite('Julia statements: docstrings', () => {
	test('a docstring runs with the definition it documents', () => {
		const lines = [
			'"""',
			'    f(x)',
			'',
			'Doubles `x`.',
			'"""',
			'function f(x)',
			'    2x',
			'end',
			'"short doc"',
			'g(x) = x',
		];
		assert.deepStrictEqual(statements(lines), [[0, 7], [8, 9]]);
		expectStatement(lines, [1, 4, 5, 7], [0, 7]);
	});

	test('a string separated by a blank line is not a docstring', () => {
		const lines = ['"just a string"', '', 'f(x) = x'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [2, 2]]);
	});
});

suite('Julia statements: modules', () => {
	const lines = [
		'"""',               // 0
		'The M module.',     // 1
		'"""',               // 2
		'module M',          // 3
		'',                  // 4
		'using LinearAlgebra', // 5
		'',                  // 6
		'function f(x)',     // 7
		'    x[end]',        // 8
		'end',               // 9
		'',                  // 10
		'end # module',      // 11
		'x = 1',             // 12
	];

	test('statements in a module body run on their own', () => {
		expectStatement(lines, [5], [5, 5]);
		expectStatement(lines, [7, 8, 9], [7, 9]);
		expectStatement(lines, [4], [5, 5]);
	});

	test('the module line, its docstring and its end run the whole module', () => {
		expectStatement(lines, [0, 2, 3, 11], [0, 11]);
	});

	test('a blank line after the last body statement runs the module', () => {
		expectStatement(lines, [10], [0, 11]);
	});

	test('statements after the module', () => {
		expectStatement(lines, [12], [12, 12]);
	});

	test('nested modules', () => {
		const nested = [
			'module A',
			'module B',
			'b = 1',
			'end',
			'a = 1',
			'end',
		];
		const segmentation = segmentJuliaStatements(nested);
		assert.deepStrictEqual(segmentation.statements.map(s => [s.startLine, s.endLine]), [[2, 2], [4, 4]]);
		assert.deepStrictEqual(segmentation.modules.map(m => [m.startLine, m.endLine]), [[0, 5], [1, 3]]);
		expectStatement(nested, [1, 3], [1, 3]);
	});

	test('a quoted module is an ordinary statement', () => {
		const quoted = ['@eval module Tmp', 'x = 1', 'end', 'y = 2'];
		assert.deepStrictEqual(statements(quoted), [[0, 2], [3, 3]]);
		assert.deepStrictEqual(segmentJuliaStatements(quoted).modules, []);
	});
});

suite('Julia statements: incomplete code', () => {
	test('an unclosed block above the cursor does not swallow the statements below it', () => {
		const lines = [
			'function f(x)',   // never closed
			'    x + 1',
			'',
			'for i in 1:3',
			'    println(i)',
			'end',
			'',
			'y = 2',
		];
		expectStatement(lines, [7], [7, 7]);
		expectStatement(lines, [3, 4], [3, 5]);
		expectStatement(lines, [6], [7, 7]);
	});

	test('an unclosed statement at the cursor runs to its last line', () => {
		const lines = ['x = [1,', '     2,', '', '# end of file'];
		expectStatement(lines, [0], [0, 1]);
	});

	test('an unclosed string does not hide statements above it', () => {
		const lines = ['a = 1', 'b = 2', 's = "never closed', 'c = 3'];
		expectStatement(lines, [0], [0, 0]);
		expectStatement(lines, [1], [1, 1]);
	});

	test('recovers when the cursor is inside the unclosed block', () => {
		const lines = [
			'function f(x)',   // `end` not typed yet
			'    y = g(x,',
			'          2)',
			'    return y',
		];
		expectStatement(lines, [0], [0, 3]);
		expectStatement(lines, [1, 2], [1, 2]);
		expectStatement(lines, [3], [3, 3]);
	});

	test('a raw string ending in an escaped quote stays open', () => {
		// In raw"C:\dir\" the backslash escapes the quote, as in Julia.
		const lines = ['p = raw"C:\\dir\\"', 'x = 1'];
		expectStatement(lines, [0], [0, 1]);
	});

	test('stray closers are ignored', () => {
		const lines = ['x = f(1))', 'end', 'y = 2'];
		assert.deepStrictEqual(statements(lines), [[0, 0], [1, 1], [2, 2]]);
	});
});

suite('Julia statements: documents', () => {
	test('empty and comment-only documents have no statements', () => {
		assert.deepStrictEqual(at([''], 0), undefined);
		assert.deepStrictEqual(at(['# only a comment', ''], 0), undefined);
	});

	test('semicolon-separated statements on one line run together', () => {
		assert.deepStrictEqual(at(['a = 1; b = 2', 'c = 3'], 0), [0, 0]);
	});

	test('cell markers are comments', () => {
		const lines = ['# %% setup', 'x = 1', '', '## next cell', 'y = 2'];
		assert.deepStrictEqual(statements(lines), [[1, 1], [4, 4]]);
	});
});
