/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the Julia code behind Positron's Import Data dialog.
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';
import type * as positron from 'positron';

import {
	generateCsvImportCode,
	generateParquetImportCode,
	generateXlsxImportCode,
	JULIA_RESERVED_NAMES,
	juliaPathLiteral,
	juliaStringLiteral,
} from '../../julia-data-import';

type Filter = positron.DataImportRowFilter;

const csv = (overrides: Partial<Parameters<typeof generateCsvImportCode>[0]> = {}) =>
	generateCsvImportCode({ pathLiteral: '"data/sales.csv"', variableName: 'sales', ...overrides });

/** The `filter!` line generated for `filters` on a CSV file. */
function filterLine(...filters: Filter[]): string | undefined {
	const { code } = csv({ view: { rowFilters: filters, sortKeys: [] } });
	return code.split('\n').find(line => line.startsWith('filter!'));
}

const base = { columnName: 'x', condition: 'and' as const };

suite('Julia data import: load code', () => {

	test('CSV', () => {
		assert.strictEqual(csv().code, [
			'using CSV, DataFrames',
			'',
			'# Load sales data',
			'sales = CSV.read("data/sales.csv", DataFrame)',
			'',
		].join('\n'));
	});

	test('TSV uses a tab delimiter; no header row is passed on', () => {
		const tsv = generateCsvImportCode({ pathLiteral: '"a/b.TSV"', variableName: 'b', hasHeaderRow: false });
		assert.ok(tsv.code.includes(`b = CSV.read("a/b.TSV", DataFrame; delim = '\\t', header = false)`), tsv.code);
		// A directory named like a TSV file does not count.
		assert.ok(!csv({ pathLiteral: '"x.tsv/y.csv"' }).code.includes('delim'));
	});

	test('XLSX reads the named sheet, escaped, or the first one', () => {
		const named = generateXlsxImportCode({ pathLiteral: '"book.xlsx"', variableName: 'b', sheetName: 'Q1 "$fy"' });
		assert.ok(named.code.startsWith('using XLSX, DataFrames\n'));
		assert.ok(named.code.includes('b = DataFrame(XLSX.readtable("book.xlsx", "Q1 \\"\\$fy\\""))'), named.code);
		const first = generateXlsxImportCode({ pathLiteral: '"book.xlsx"', variableName: 'b', hasHeaderRow: false });
		assert.ok(first.code.includes('DataFrame(XLSX.readtable("book.xlsx", 1; header = false))'), first.code);
	});

	test('Parquet', () => {
		const { code } = generateParquetImportCode({ pathLiteral: '"t.parquet"', variableName: 't' });
		assert.ok(code.startsWith('using Parquet, DataFrames\n'));
		assert.ok(code.includes('t = DataFrame(read_parquet("t.parquet"))'));
	});

	test('no view: nothing unsupported, no filter or sort', () => {
		const result = csv();
		assert.deepStrictEqual(result.unsupported, []);
		assert.ok(!result.code.includes('filter!') && !result.code.includes('sort!'));
	});
});

suite('Julia data import: filters', () => {
	const x = 'row["x"]';
	const present = (predicate: string) => `(!ismissing(${x}) && ${predicate})`;

	test('null and empty checks', () => {
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'is_null' }), `filter!(row -> ismissing(${x}), sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'not_null' }), `filter!(row -> !ismissing(${x}), sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'is_empty' }), `filter!(row -> ${present(`${x} == ""`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'not_empty' }), `filter!(row -> ${present(`${x} != ""`)}, sales)`);
	});

	test('boolean checks', () => {
		assert.strictEqual(filterLine({ ...base, columnType: 'boolean', filterType: 'is_true' }), `filter!(row -> ${present(`${x} == true`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'boolean', filterType: 'is_false' }), `filter!(row -> ${present(`${x} == false`)}, sales)`);
	});

	test('comparisons with typed literals', () => {
		assert.strictEqual(filterLine({ ...base, columnType: 'integer', filterType: 'compare', op: '=', value: ' 42 ' }), `filter!(row -> ${present(`${x} == 42`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'floating', filterType: 'compare', op: '>=', value: '1.5E3' }), `filter!(row -> ${present(`${x} >= 1.5E3`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'boolean', filterType: 'compare', op: '!=', value: 'TRUE' }), `filter!(row -> ${present(`${x} != true`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'compare', op: '<', value: 'm' }), `filter!(row -> ${present(`${x} < "m"`)}, sales)`);
	});

	test('between and not between', () => {
		assert.strictEqual(filterLine({ ...base, columnType: 'integer', filterType: 'between', leftValue: '1', rightValue: '5' }), `filter!(row -> ${present(`1 <= ${x} <= 5`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'integer', filterType: 'not_between', leftValue: '1', rightValue: '5' }), `filter!(row -> ${present(`!(1 <= ${x} <= 5)`)}, sales)`);
	});

	test('set membership, inclusive and not, with a one-element tuple', () => {
		assert.strictEqual(filterLine({ ...base, columnType: 'string', filterType: 'set_membership', values: ['a', 'b'], inclusive: true }), `filter!(row -> ${present(`${x} in ("a", "b",)`)}, sales)`);
		assert.strictEqual(filterLine({ ...base, columnType: 'integer', filterType: 'set_membership', values: ['7'], inclusive: false }), `filter!(row -> ${present(`!(${x} in (7,))`)}, sales)`);
	});

	test('text search, case sensitive and not', () => {
		const search = (searchType: positron.DataImportSearchFilter['searchType'], caseSensitive: boolean) =>
			filterLine({ ...base, columnType: 'string', filterType: 'search', searchType, term: 'AbC', caseSensitive });
		assert.strictEqual(search('contains', true), `filter!(row -> ${present(`occursin("AbC", ${x})`)}, sales)`);
		assert.strictEqual(search('contains', false), `filter!(row -> ${present(`occursin("abc", lowercase(${x}))`)}, sales)`);
		assert.strictEqual(search('not_contains', true), `filter!(row -> ${present(`!occursin("AbC", ${x})`)}, sales)`);
		assert.strictEqual(search('starts_with', false), `filter!(row -> ${present(`startswith(lowercase(${x}), "abc")`)}, sales)`);
		assert.strictEqual(search('ends_with', true), `filter!(row -> ${present(`endswith(${x}, "AbC")`)}, sales)`);
		assert.strictEqual(search('regex_match', true), `filter!(row -> ${present(`occursin(Regex("AbC"), ${x})`)}, sales)`);
		assert.strictEqual(search('regex_match', false), `filter!(row -> ${present(`occursin(Regex("AbC", "i"), ${x})`)}, sales)`);
	});

	test('filters join in order with && and ||', () => {
		assert.strictEqual(filterLine(
			{ ...base, columnName: 'a', columnType: 'string', filterType: 'not_null' },
			{ ...base, columnName: 'b', columnType: 'string', filterType: 'is_null' },
			{ ...base, columnName: 'c', columnType: 'string', filterType: 'is_null', condition: 'or' },
		), 'filter!(row -> !ismissing(row["a"]) && ismissing(row["b"]) || ismissing(row["c"]), sales)');
	});

	test('column names with spaces, quotes and $ are safe', () => {
		assert.strictEqual(filterLine({ ...base, columnName: 'unit "$" price', columnType: 'string', filterType: 'is_null' }),
			'filter!(row -> ismissing(row["unit \\"\\$\\" price"]), sales)');
	});
});

suite('Julia data import: sorts and unsupported parts', () => {

	test('sorts become one sort!, descending keys keeping missing last', () => {
		const { code } = csv({ view: { rowFilters: [], sortKeys: [{ columnName: 'amount', ascending: false }, { columnName: 'region', ascending: true }] } });
		assert.ok(code.endsWith([
			'# Filter and sort as shown in the Data Explorer',
			'sort!(sales, [order("amount", lt = Base.isgreater), "region"])',
			'',
		].join('\n')), code);
	});

	test('untranslatable filters are reported, the rest still apply', () => {
		const result = csv({
			view: {
				rowFilters: [
					{ ...base, columnName: 'when', columnType: 'date', filterType: 'compare', op: '>', value: '2026-01-01' },
					{ ...base, columnName: 'n', columnType: 'integer', filterType: 'compare', op: '=', value: 'abc' },
					{ ...base, columnName: 'n', columnType: 'integer', filterType: 'set_membership', values: ['1', 'x'], inclusive: true },
					{ ...base, columnName: 'ok', columnType: 'string', filterType: 'not_null' },
				],
				sortKeys: [],
			},
		});
		assert.deepStrictEqual(result.unsupported, [
			'filter on "when" (compare)',
			'filter on "n" (compare)',
			'filter on "n" (set_membership)',
		]);
		assert.ok(result.code.includes('filter!(row -> !ismissing(row["ok"]), sales)'));
	});

	test('a file without a header row cannot reproduce the view', () => {
		const result = csv({
			hasHeaderRow: false,
			view: { rowFilters: [{ ...base, columnType: 'string', filterType: 'not_null' }], sortKeys: [{ columnName: 'x', ascending: true }] },
		});
		assert.deepStrictEqual(result.unsupported, ['filters and sorts (the file has no header row, so the loaded columns are not named)']);
		assert.ok(!result.code.includes('filter!') && !result.code.includes('sort!'));
	});
});

suite('Julia data import: literals and names', () => {

	test('string literals escape backslash, quote, $ and control characters', () => {
		assert.strictEqual(juliaStringLiteral('a\\b"c$d\ne\tf\u0001'), '"a\\\\b\\"c\\$d\\ne\\tf\\x01"');
	});

	test('path literals from formatPathForCode get $ escaped', () => {
		assert.strictEqual(juliaPathLiteral('"data/$HOME/\\"q\\".csv"'), '"data/\\$HOME/\\"q\\".csv"');
	});

	test('reserved names include the keywords a file name could produce', () => {
		for (const word of ['end', 'begin', 'function', 'module', 'true', 'false', 'using', 'ccall']) {
			assert.ok(JULIA_RESERVED_NAMES.includes(word), word);
		}
	});
});
