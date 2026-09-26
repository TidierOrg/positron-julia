/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// The data importer API from posit-dev/positron `src/positron-dts/positron.d.ts` at tag
// 2026.09.1-2, copied verbatim. It is newer than the 2026.08 minimum that `positron.d.ts` in
// this folder describes: `positron.dataExplorer.registerDataImporter` does not exist on
// Positron 2026.08, so check for it before calling.

declare module 'positron' {

	import * as vscode from 'vscode';

	/**
	 * Import options that are not part of the file's identity. This bag is the seam for future
	 * options (delimiter, skip rows, NA strings, column types, encoding).
	 */
	export interface DataImportOptions {
		/** Whether the first row of the file holds column names. Defaults to true when absent. */
		hasHeaderRow?: boolean;

		/** The worksheet to read, for formats that have sheets. */
		sheetName?: string;
	}

	/**
	 * A column sort from the Data Explorer view. The column is named rather than indexed, because
	 * the generated code operates on the loaded dataframe, where names are the only stable handle.
	 */
	export interface DataImportSortKey {
		/** The name of the column to sort by. */
		columnName: string;

		/** Sort order: ascending (true) or descending (false). */
		ascending: boolean;
	}

	/** The fields every row filter carries, whatever its type. */
	export interface DataImportRowFilterBase {
		/** The name of the column the filter applies to. */
		columnName: string;

		/** The column's canonical Positron display type, e.g. 'integer', 'string', 'boolean'. */
		columnType: string;

		/** How this filter combines with the one before it. Ignored on the first filter. */
		condition: 'and' | 'or';
	}

	/** Keeps rows where the column's value falls inside (or, for not_between, outside) a range. */
	export interface DataImportBetweenFilter extends DataImportRowFilterBase {
		filterType: 'between' | 'not_between';
		/** The lower limit, as a stringified column value. */
		leftValue: string;
		/** The upper limit, as a stringified column value. */
		rightValue: string;
	}

	/** Keeps rows satisfying a binary comparison against one value. */
	export interface DataImportCompareFilter extends DataImportRowFilterBase {
		filterType: 'compare';
		op: '=' | '!=' | '<' | '<=' | '>' | '>=';
		/** The comparison value, as a stringified column value. */
		value: string;
	}

	/** Keeps rows whose text matches a search term. */
	export interface DataImportSearchFilter extends DataImportRowFilterBase {
		filterType: 'search';
		searchType: 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'regex_match';
		term: string;
		caseSensitive: boolean;
	}

	/** Keeps rows whose value is in (or, when not inclusive, not in) a set. */
	export interface DataImportSetMembershipFilter extends DataImportRowFilterBase {
		filterType: 'set_membership';
		/** The set members, as stringified column values. */
		values: string[];
		inclusive: boolean;
	}

	/** A row filter that needs no parameters beyond its type. */
	export interface DataImportUnaryFilter extends DataImportRowFilterBase {
		filterType: 'is_null' | 'not_null' | 'is_empty' | 'not_empty' | 'is_true' | 'is_false';
	}

	/**
	 * One row filter from the Data Explorer view, discriminated on filterType so a generator can
	 * switch over it exhaustively and route any type it cannot translate to `unsupported`.
	 */
	export type DataImportRowFilter =
		| DataImportBetweenFilter
		| DataImportCompareFilter
		| DataImportSearchFilter
		| DataImportSetMembershipFilter
		| DataImportUnaryFilter;

	/**
	 * The Data Explorer view at the moment the dialog opened: what the user is looking at beyond
	 * the raw file. Row filters marked invalid by the backend are excluded, because they are not
	 * applied to the on-screen data either.
	 */
	export interface DataImportView {
		rowFilters: DataImportRowFilter[];
		sortKeys: DataImportSortKey[];
	}

	/**
	 * A request to generate the code that loads one file into one variable.
	 */
	export interface DataImportRequest {
		/** The original file, not the positron-data-explorer URI. */
		fileUri: vscode.Uri;

		/**
		 * The target variable name, as entered by the user. This is arbitrary text, not
		 * validated or sanitized for the importer's language: Positron does not check that it is
		 * assignable, and importers are not expected to either. A name that is not a valid
		 * identifier in the importer's language produces code that fails to run, which the code
		 * preview already shows the user before they run it.
		 */
		variableName: string;

		/** Format and parsing options. */
		options: DataImportOptions;

		/**
		 * The Data Explorer view to reproduce (row filters and sorts), present
		 * only when the user asked to include the current filters and sorts. Anything the importer
		 * cannot translate belongs in the result's `unsupported` list, never dropped silently.
		 */
		view?: DataImportView;
	}

	/**
	 * Generated import code, plus anything the importer could not express.
	 */
	export interface DataImportResult {
		/** The generated code, ready to run in a console. */
		code: string;

		/**
		 * Human-readable descriptions of anything in the request the importer could not translate.
		 * Positron shows these as a warning next to the generated code, so that nothing is dropped
		 * silently.
		 */
		unsupported?: string[];
	}

	/**
	 * Generates the code that loads a data file into a variable, for one language and library. The
	 * declared file extensions are what keep an importer off files it cannot read.
	 */
	export interface DataImporter {
		/** The language the generated code is written in, e.g. 'python'. */
		languageId: string;

		/** A human-readable name for the importer, e.g. 'Python (pandas)'. */
		displayName: string;

		/** File extensions this importer can read, without a leading dot, e.g. ['csv', 'tsv']. */
		fileExtensions: string[];

		/**
		 * Words this language will not let you assign to, e.g. 'class' for Python or 'if' for R.
		 *
		 * Positron derives the default variable name from the file name, restricted to an ASCII
		 * letter followed by letters, digits and underscores, which is assignable in any language
		 * an importer is likely to target. A reserved word is the one case that rule cannot catch,
		 * so supply the language's list and Positron suffixes any collision: a file named class.csv
		 * is offered as 'class_'. Omitting the list means such a file is offered as 'class'.
		 */
		reservedNames?: string[];

		/**
		 * Generates the code that loads the requested file.
		 *
		 * @param request The file, the target variable name, and the import options.
		 * @returns The generated code, or undefined to decline.
		 */
		generateCode(request: DataImportRequest): vscode.ProviderResult<DataImportResult>;
	}

	namespace dataExplorer {
		/**
		 * Registers a data importer, which generates the code that loads a data file into a variable.
		 *
		 * The importer is offered for files whose extension it declares, and its generated code is
		 * shown to the user before it runs.
		 *
		 * @param importer The importer to register.
		 * @returns A disposable that unregisters the importer.
		 */
		export function registerDataImporter(importer: DataImporter): vscode.Disposable;
	}
}
