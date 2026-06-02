/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime completion provider for Julia.
 *
 * Asks the live Julia kernel for REPL.completions of the text up to the cursor.
 * The kernel writes results to a temp file (not stdout) so Positron's
 * supervisor does not leak the raw output to the user's console for Silent
 * executions. We then listen on the session's raw message stream for the
 * matching Idle state to know when the query has finished, and read the file.
 *
 * This mirrors the pattern used by JuliaPackageManager in packages.ts.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER } from './extension';
import { JuliaSession } from './session';

const COMPLETION_TIMEOUT_MS = 3_000;

/**
 * Escape a string for embedding as a Julia double-quoted string literal.
 * Escapes `$` so Julia string interpolation cannot run.
 */
function escapeForJulia(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

/**
 * Build the Julia snippet that runs REPL.completions and writes results
 * to a temp file in the form:
 *   <cursor_start_0indexed>
 *   <match1>
 *   <match2>
 *   ...
 */
function buildCompletionSnippet(query: string, tempFile: string): string {
	const escQuery = escapeForJulia(query);
	const escPath = escapeForJulia(tempFile);
	const cursorPos = query.length;

	return [
		`import REPL`,
		`let __positron_io = open("${escPath}", "w")`,
		`  try`,
		`    cs, range = try`,
		`      r = Base.invokelatest(REPL.completions, "${escQuery}", ${cursorPos}, Main)`,
		`      (r[1], r[2])`,
		`    catch`,
		`      (REPL.REPLCompletions.Completion[], 1:0)`,
		`    end`,
		`    println(__positron_io, isempty(range) ? ${cursorPos} : first(range) - 1)`,
		`    for c in cs`,
		`      try`,
		`        println(__positron_io, REPL.completion_text(c))`,
		`      catch`,
		`      end`,
		`    end`,
		`  finally`,
		`    close(__positron_io)`,
		`  end`,
		`end`,
	].join('\n');
}

/**
 * Parse the file produced by buildCompletionSnippet.
 */
function parseCompletionOutput(text: string, queryLength: number): ReplCompletionResult | null {
	const lines = text.split(/\r?\n/);
	if (lines.length === 0 || !lines[0]) {
		return null;
	}
	const cursor_start = parseInt(lines[0], 10);
	const matches = lines.slice(1).filter(s => s.length > 0);
	if (matches.length === 0) {
		return null;
	}
	return {
		matches,
		cursor_start: isNaN(cursor_start) ? 0 : cursor_start,
		cursor_end: queryLength,
	};
}

/**
 * Execute Julia code silently on the given session and resolve when the
 * kernel reports Idle for that execution. Mirrors the pattern in
 * JuliaPackageManager._execute (packages.ts).
 */
function executeSilentAndWait(
	session: JuliaSession,
	code: string,
	timeoutMs: number,
	token?: vscode.CancellationToken,
): Promise<void> {
	const executionId = `positron-julia-completions-${crypto.randomUUID()}`;

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let listenersDisposed = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let cleanupHandle: NodeJS.Timeout | undefined;
		let messageDisposable: vscode.Disposable | undefined;
		let suppressDisposable: vscode.Disposable | undefined;
		let cancelDisposable: vscode.Disposable | undefined;

		const disposeListeners = () => {
			if (listenersDisposed) { return; }
			listenersDisposed = true;
			if (cleanupHandle) {
				clearTimeout(cleanupHandle);
				cleanupHandle = undefined;
			}
			suppressDisposable?.dispose();
			messageDisposable?.dispose();
		};

		const scheduleForceCleanup = () => {
			if (listenersDisposed || cleanupHandle) { return; }
			cleanupHandle = setTimeout(disposeListeners, 30_000);
		};

		const settle = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			cancelDisposable?.dispose();
			cancelDisposable = undefined;
			fn();
		};

		if (token?.isCancellationRequested) {
			reject(new vscode.CancellationError());
			return;
		}

		cancelDisposable = token?.onCancellationRequested(() => {
			// Silent queries: do NOT interrupt the kernel — that raises an
			// InterruptException whose message Positron surfaces to the
			// console. Just abandon the awaited result; the listener stays
			// alive until the kernel finishes and reports Idle.
			settle(() => reject(new vscode.CancellationError()));
			scheduleForceCleanup();
		});

		timeoutHandle = setTimeout(() => {
			settle(() => reject(new Error(`Julia completion timed out after ${timeoutMs}ms`)));
			scheduleForceCleanup();
		}, timeoutMs);

		suppressDisposable = session.suppressRuntimeMessages(executionId);

		messageDisposable = session.onDidReceiveRuntimeMessageRaw((msg) => {
			if (msg.parent_id !== executionId) { return; }

			switch (msg.type) {
				case positron.LanguageRuntimeMessageType.Error: {
					const err = msg as positron.LanguageRuntimeError;
					settle(() => reject(new Error(`Julia completion failed: ${err.name}: ${err.message}`)));
					break;
				}
				case positron.LanguageRuntimeMessageType.State: {
					const state = msg as positron.LanguageRuntimeState;
					if (state.state === positron.RuntimeOnlineState.Idle) {
						settle(() => resolve());
						disposeListeners();
					}
					break;
				}
				default:
					break;
			}
		});

		try {
			session.execute(
				code,
				executionId,
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue,
			);
		} catch (error) {
			settle(() => reject(error instanceof Error ? error : new Error(String(error))));
			disposeListeners();
		}
	});
}

/**
 * Provides runtime completions for Julia by querying the active Julia session.
 * Supplements LSP completions with variables and bindings defined in the live
 * REPL state — including struct fields, dict keys, and module members that
 * the static LSP cannot see.
 */
export class JuliaRuntimeCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {

	constructor(private readonly _getSession: () => JuliaSession | undefined) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[] | undefined> {

		if (document.languageId !== 'julia') {
			return undefined;
		}

		const lineText = document.lineAt(position.line).text;
		const query = lineText.substring(0, position.character);

		if (!query.trim()) {
			return undefined;
		}

		const session = this._getSession();
		if (!session) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		const result = await runCompletionQuery(session, query, token);
		if (!result || result.matches.length === 0) {
			return undefined;
		}

		const replaceRange = new vscode.Range(
			position.line, result.cursor_start,
			position.line, position.character,
		);

		return result.matches.map(text => {
			const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Variable);
			item.range = replaceRange;
			item.sortText = ` ${text}`; // space prefix sorts runtime items before LSP items
			item.detail = '(runtime)';
			return item;
		});
	}

	dispose(): void {
		// nothing to clean up
	}
}

/**
 * Run a single completion query against the live Julia session and return
 * the parsed result. Returns null on any failure (no session, error, timeout,
 * cancellation, or empty result).
 */
async function runCompletionQuery(
	session: JuliaSession,
	query: string,
	token?: vscode.CancellationToken,
): Promise<ReplCompletionResult | null> {
	const tempFile = path.join(
		os.tmpdir(),
		`positron-julia-completions-${crypto.randomUUID()}.txt`,
	);

	try {
		await executeSilentAndWait(
			session,
			buildCompletionSnippet(query, tempFile),
			COMPLETION_TIMEOUT_MS,
			token,
		);

		const text = await fs.promises.readFile(tempFile, 'utf-8');
		return parseCompletionOutput(text, query.length);
	} catch (err) {
		if (!(err instanceof vscode.CancellationError)) {
			LOGGER.debug(`Runtime completion query failed: ${err}`);
		}
		return null;
	} finally {
		fs.promises.unlink(tempFile).catch(() => { /* ignore */ });
	}
}

/**
 * Registers the Julia runtime completion provider.
 */
export function registerCompletionProvider(
	context: vscode.ExtensionContext,
	getSession: () => JuliaSession | undefined,
): vscode.Disposable {
	const provider = new JuliaRuntimeCompletionProvider(getSession);

	const disposable = vscode.languages.registerCompletionItemProvider(
		[
			{ language: 'julia', scheme: 'file' },
			{ language: 'julia', scheme: 'untitled' },
			{ language: 'julia', scheme: 'inmemory' },
		],
		provider,
		'.', // trigger on dot for field/module member completion
	);

	context.subscriptions.push(disposable);
	context.subscriptions.push(provider);

	LOGGER.info('Julia runtime completion provider registered');

	return disposable;
}

export interface ReplCompletionResult {
	matches: string[];
	cursor_start: number;
	cursor_end: number;
}

/**
 * Queries the active Julia runtime session for completions, intended for use
 * by the LanguageServer.jl `repl/getCompletions` bridge.
 *
 * Returns null when no Julia session is active or the query is empty.
 */
export async function getRuntimeCompletions(
	getSession: () => JuliaSession | undefined,
	query: string,
): Promise<ReplCompletionResult | null> {
	if (!query || !query.trim()) {
		return null;
	}
	const session = getSession();
	if (!session) {
		return null;
	}
	return runCompletionQuery(session, query);
}
