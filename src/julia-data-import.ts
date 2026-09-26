/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia code for Positron's Import Data dialog (Positron 2026.09+): the lines
 * that load a CSV/TSV, Excel or Parquet file into a DataFrame and, when asked,
 * reproduce the Data Explorer's filters and sorts. Mirrors the R importers in
 * posit-dev/positron `extensions/positron-r/src/data-import.ts`.
 *
 * Only types come from `positron`, so this module can be unit tested under
 * plain Node.
 */

import type * as positron from 'positron';

/** A request to generate the code that loads one file into one variable. */
export interface JuliaImportRequest {
	/**
	 * The file path as a ready-to-embed Julia string literal (see
	 * {@link juliaPathLiteral}): workspace-relative when the file is inside the
	 * workspace, absolute otherwise.
	 */
	pathLiteral: string;
	/** The target variable name, as the user entered it. */
	variableName: string;
	/** Whether the first row holds column names. Treated as true when absent. */
	hasHeaderRow?: boolean;
	/** The worksheet to read, for Excel files. Omitted means the first sheet. */
	sheetName?: string;
	/** The Data Explorer view (filters and sorts) to reproduce, if requested. */
	view?: positron.DataImportView;
}

/** The generated code plus anything in the view it does not reproduce. */
export interface JuliaImportResult {
	code: string;
	unsupported: string[];
}

/**
 * `value` as a double-quoted Julia string literal. Besides `\` and `"`, `$`
 * must be escaped (it interpolates) and control characters are written as
 * escapes, so arbitrary filter terms and column names cannot change the code.
 */
export function juliaStringLiteral(value: string): string {
	const escaped = value.replace(/[\\"$\u0000-\u001f\u007f]/g, character => {
		switch (character) {
			case '\\':
				return '\\\\';
			case '"':
				return '\\"';
			case '$':
				return '\\$';
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\t':
				return '\\t';
			default:
				return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
		}
	});
	return `"${escaped}"`;
}

/**
 * Makes the output of `positron.paths.formatPathForCode` (a `"…"` literal with
 * `/` separators and `\"` escapes, meant for R and Python) safe for Julia,
 * where `$` interpolates.
 */
export function juliaPathLiteral(formattedPath: string): string {
	return formattedPath.replace(/\$/g, '\\$');
}

/**
 * Names that cannot be assigned to in Julia: the keywords (`end = CSV.read(...)`
 * is a parse error) and `ccall`, which is syntax too. Checked against Julia
 * 1.12 and 1.13. Positron suffixes a default variable name that collides with
 * one, e.g. a file named `end.csv` is offered as `end_`.
 */
export const JULIA_RESERVED_NAMES = [
	'baremodule', 'begin', 'break', 'catch', 'const', 'continue', 'do', 'else',
	'elseif', 'end', 'export', 'false', 'finally', 'for', 'function', 'global',
	'if', 'import', 'let', 'local', 'macro', 'module', 'quote', 'return',
	'struct', 'true', 'try', 'using', 'while', 'ccall',
];

/** Display types whose stringified values are emitted as bare numeric literals. */
const NUMERIC_COLUMN_TYPES = new Set(['integer', 'floating', 'decimal']);

const NUMERIC_LITERAL = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A stringified Data Explorer value as a Julia literal of the column's type, or
 * undefined when it cannot be one (the filter is then reported as unsupported).
 */
function juliaLiteral(value: string, columnType: string): string | undefined {
	const trimmed = value.trim();
	if (NUMERIC_COLUMN_TYPES.has(columnType)) {
		return NUMERIC_LITERAL.test(trimmed) ? trimmed : undefined;
	}
	if (columnType === 'boolean') {
		if (/^true$/i.test(trimmed)) {
			return 'true';
		}
		if (/^false$/i.test(trimmed)) {
			return 'false';
		}
		return undefined;
	}
	if (columnType === 'string') {
		return juliaStringLiteral(value);
	}
	return undefined;
}

/** A column of the row inside the `filter!` predicate; valid for any name. */
function juliaColumn(columnName: string): string {
	return `row[${juliaStringLiteral(columnName)}]`;
}

// The Data Explorer backend is SQL (DuckDB), where a comparison with NULL is
// NULL and drops the row, negated or not. A DataFrames predicate that returns
// `missing` throws instead, so every term except the null checks requires a
// present value first -- which also gives negations the SQL behavior.
// Regular expressions run as PCRE in Julia and RE2 in DuckDB; the common
// syntax behaves the same.
function searchPredicate(column: string, filter: positron.DataImportSearchFilter): string {
	if (filter.searchType === 'regex_match') {
		const flags = filter.caseSensitive ? '' : ', "i"';
		return `occursin(Regex(${juliaStringLiteral(filter.term)}${flags}), ${column})`;
	}
	const target = filter.caseSensitive ? column : `lowercase(${column})`;
	const term = juliaStringLiteral(filter.caseSensitive ? filter.term : filter.term.toLowerCase());
	switch (filter.searchType) {
		case 'contains':
			return `occursin(${term}, ${target})`;
		case 'not_contains':
			return `!occursin(${term}, ${target})`;
		case 'starts_with':
			return `startswith(${target}, ${term})`;
		case 'ends_with':
			return `endswith(${target}, ${term})`;
	}
}

/** One row filter as a predicate term. Undefined means untranslatable. */
function juliaFilterTerm(filter: positron.DataImportRowFilter): string | undefined {
	const column = juliaColumn(filter.columnName);
	const present = (predicate: string) => `(!ismissing(${column}) && ${predicate})`;
	switch (filter.filterType) {
		case 'is_null':
			return `ismissing(${column})`;
		case 'not_null':
			return `!ismissing(${column})`;
		case 'is_empty':
			return present(`${column} == ""`);
		case 'not_empty':
			return present(`${column} != ""`);
		case 'is_true':
			return present(`${column} == true`);
		case 'is_false':
			return present(`${column} == false`);
		case 'compare': {
			const literal = juliaLiteral(filter.value, filter.columnType);
			if (literal === undefined) {
				return undefined;
			}
			const op = filter.op === '=' ? '==' : filter.op;
			return present(`${column} ${op} ${literal}`);
		}
		case 'between':
		case 'not_between': {
			const low = juliaLiteral(filter.leftValue, filter.columnType);
			const high = juliaLiteral(filter.rightValue, filter.columnType);
			if (low === undefined || high === undefined) {
				return undefined;
			}
			const range = `${low} <= ${column} <= ${high}`;
			return present(filter.filterType === 'between' ? range : `!(${range})`);
		}
		case 'set_membership': {
			const literals = filter.values.map(value => juliaLiteral(value, filter.columnType));
			if (literals.some(literal => literal === undefined)) {
				return undefined;
			}
			const set = literals.length === 0 ? '()' : `(${literals.join(', ')},)`;
			return present(filter.inclusive ? `${column} in ${set}` : `!(${column} in ${set})`);
		}
		case 'search':
			return present(searchPredicate(column, filter));
	}
}

/**
 * The view as in-place DataFrames.jl steps on the loaded frame: one `filter!`
 * whose terms join in order (`&&` binds tighter than `||`, like the backend's
 * AND/OR), then one `sort!` (stable, so ties keep file order).
 *
 * `condition` is always 'and' today and the DuckDB backend ANDs its filters
 * regardless; if the UI ever emits 'or', re-check the `||` join against the
 * backend (see the same note in Positron's R importer).
 */
function translateView(
	view: positron.DataImportView,
	hasHeaderRow: boolean | undefined,
	variableName: string,
	unsupported: string[],
): string[] {
	if (hasHeaderRow === false) {
		// Without a header row the loaded columns are named Column1..Columnn, so
		// the Data Explorer's column names do not exist in the DataFrame.
		unsupported.push('filters and sorts (the file has no header row, so the loaded columns are not named)');
		return [];
	}

	const steps: string[] = [];

	let condition = '';
	for (const filter of view.rowFilters) {
		const term = juliaFilterTerm(filter);
		if (term === undefined) {
			unsupported.push(`filter on "${filter.columnName}" (${filter.filterType})`);
			continue;
		}
		condition = condition.length === 0 ? term : `${condition} ${filter.condition === 'or' ? '||' : '&&'} ${term}`;
	}
	if (condition.length > 0) {
		steps.push(`filter!(row -> ${condition}, ${variableName})`);
	}

	if (view.sortKeys.length > 0) {
		// DuckDB sorts nulls last in both directions. `isless` already puts
		// missing last when ascending; `rev = true` would put it first, while
		// `Base.isgreater` keeps it last.
		const keys = view.sortKeys.map(key => {
			const column = juliaStringLiteral(key.columnName);
			return key.ascending ? column : `order(${column}, lt = Base.isgreater)`;
		});
		steps.push(`sort!(${variableName}, [${keys.join(', ')}])`);
	}

	return steps;
}

/**
 * The `using` line, the labelled load, and the view steps, if any. Shared by
 * every Julia importer; only the packages and the load call differ.
 */
function assembleJuliaImportCode(
	packages: string[],
	loadCall: string,
	variableName: string,
	view: positron.DataImportView | undefined,
	hasHeaderRowForView: boolean | undefined,
): JuliaImportResult {
	const unsupported: string[] = [];
	const steps = view ? translateView(view, hasHeaderRowForView, variableName, unsupported) : [];

	const lines = [
		`using ${packages.join(', ')}`,
		'',
		`# Load ${variableName} data`,
		`${variableName} = ${loadCall}`,
	];
	if (steps.length > 0) {
		lines.push('', '# Filter and sort as shown in the Data Explorer', ...steps);
	}
	lines.push('');

	return { code: lines.join('\n'), unsupported };
}

/**
 * Whether the path literal names a tab-separated file. The closing quote is
 * part of the match, so a directory named `x.tsv` cannot fool it.
 */
function isTabSeparated(pathLiteral: string): boolean {
	return /\.tsv"$/i.test(pathLiteral);
}

/** CSV.jl code that loads a CSV or TSV file. */
export function generateCsvImportCode(request: JuliaImportRequest): JuliaImportResult {
	const options: string[] = [];
	if (isTabSeparated(request.pathLiteral)) {
		options.push(`delim = '\\t'`);
	}
	if (request.hasHeaderRow === false) {
		options.push('header = false');
	}
	const keywords = options.length > 0 ? `; ${options.join(', ')}` : '';
	return assembleJuliaImportCode(
		['CSV', 'DataFrames'],
		`CSV.read(${request.pathLiteral}, DataFrame${keywords})`,
		request.variableName,
		request.view,
		request.hasHeaderRow,
	);
}

/** XLSX.jl code that loads one worksheet of an Excel workbook. */
export function generateXlsxImportCode(request: JuliaImportRequest): JuliaImportResult {
	const sheet = request.sheetName !== undefined ? juliaStringLiteral(request.sheetName) : '1';
	const keywords = request.hasHeaderRow === false ? '; header = false' : '';
	return assembleJuliaImportCode(
		['XLSX', 'DataFrames'],
		`DataFrame(XLSX.readtable(${request.pathLiteral}, ${sheet}${keywords}))`,
		request.variableName,
		request.view,
		request.hasHeaderRow,
	);
}

/**
 * Parquet.jl code that loads a Parquet file. Parquet always stores column
 * names, so the view is translated with named columns.
 */
export function generateParquetImportCode(request: JuliaImportRequest): JuliaImportResult {
	return assembleJuliaImportCode(
		['Parquet', 'DataFrames'],
		`DataFrame(read_parquet(${request.pathLiteral}))`,
		request.variableName,
		request.view,
		undefined,
	);
}
