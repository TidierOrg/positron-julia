/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia importers for Positron's Import Data dialog (Data Explorer, File menu,
 * Variables pane, Explorer context menu). Each generates the Julia code that
 * loads a file into a DataFrame; the code comes from `julia-data-import.ts`.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER } from './extension';
import {
	generateCsvImportCode,
	generateParquetImportCode,
	generateXlsxImportCode,
	JULIA_RESERVED_NAMES,
	JuliaImportRequest,
	juliaPathLiteral,
} from './julia-data-import';

/**
 * The file as a Julia string literal: workspace-relative when it is inside the
 * workspace, so the code survives version control and other machines (the
 * console starts in the workspace root); absolute otherwise.
 */
async function juliaImportRequest(request: positron.DataImportRequest): Promise<JuliaImportRequest> {
	const formatted = await positron.paths.formatPathForCode(request.fileUri.fsPath, { relativeTo: 'workspace' });
	return {
		pathLiteral: juliaPathLiteral(formatted),
		variableName: request.variableName,
		hasHeaderRow: request.options.hasHeaderRow,
		sheetName: request.options.sheetName,
		view: request.view,
	};
}

/** The CSV.jl, XLSX.jl and Parquet.jl importers. */
export function createJuliaDataImporters(): positron.DataImporter[] {
	const importer = (
		displayName: string,
		fileExtensions: string[],
		generate: (request: JuliaImportRequest) => positron.DataImportResult,
	): positron.DataImporter => ({
		languageId: 'julia',
		displayName,
		fileExtensions,
		reservedNames: JULIA_RESERVED_NAMES,
		generateCode: async request => generate(await juliaImportRequest(request)),
	});
	return [
		importer('Julia (CSV.jl)', ['csv', 'tsv'], generateCsvImportCode),
		importer('Julia (XLSX.jl)', ['xlsx'], generateXlsxImportCode),
		importer('Julia (Parquet.jl)', ['parquet', 'parq'], generateParquetImportCode),
	];
}

/**
 * Registers the Julia importers. Import Data and its importer API arrived in
 * Positron 2026.09; on older builds there is nothing to register with.
 */
export function registerJuliaDataImporters(context: vscode.ExtensionContext): void {
	if (typeof positron.dataExplorer?.registerDataImporter !== 'function') {
		LOGGER.debug('Import Data needs Positron 2026.09 or newer; Julia importers not registered');
		return;
	}
	for (const importer of createJuliaDataImporters()) {
		context.subscriptions.push(positron.dataExplorer.registerDataImporter(importer));
	}
}
