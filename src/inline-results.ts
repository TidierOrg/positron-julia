/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inline execution results (issue #40), an opt-in feature.
 *
 * When `positron.julia.inlineResults.enabled` is on, code run from a Julia
 * editor into the console gets a marker at the end of its last line, as in
 * julia-vscode: `⋯` while it runs, then `✓` (optionally followed by a one-line
 * preview of the value) or `✗` with the error message. Hovering the marker
 * shows the full value or error.
 *
 * Executions are picked up in two ways:
 * - Positron's own Ctrl+Enter / Cmd+Enter and selection runs: Positron
 *   (2026.02+) passes the executed source location to `JuliaSession.execute`,
 *   and the outcome is read from the session's runtime messages.
 * - This extension's cell and Run Selection commands pass an execution
 *   observer to `positron.runtime.executeCode`.
 *
 * A marker disappears when the marked code is edited, when the Julia session
 * restarts, or with the "Julia: Clear Inline Results" command.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

import {
	adjustRangeForEdit,
	executedLineRange,
	LineRange,
	previewText,
	TextChange,
	truncateText,
} from './inline-results-model';

const SETTINGS_SECTION = 'positron.julia.inlineResults';
const JULIA_LANGUAGE_ID = 'julia';

/** Longest value or error preview shown next to a marker, in characters. */
const MAX_PREVIEW_LENGTH = 80;
/** Longest value or error shown in the hover, in characters. */
const MAX_HOVER_LENGTH = 4000;

type MarkState = 'running' | 'success' | 'error';

interface Mark {
	lines: LineRange;
	state: MarkState;
	/** Session that ran the code; undefined when Positron picked it. */
	sessionId: string | undefined;
	/** The value's text/plain representation, or the error message. */
	output: string | undefined;
}

/** An execution whose outcome is still to be shown on its mark. */
interface PendingExecution {
	uri: string;
	mark: Mark;
	result?: string;
	error?: string;
}

let instance: InlineResults | undefined;

/** The inline results controller, once the extension has activated. */
export function getInlineResults(): InlineResults | undefined {
	return instance;
}

/**
 * Creates the inline results controller and its "Julia: Clear Inline Results"
 * command.
 */
export function registerInlineResults(context: vscode.ExtensionContext): InlineResults {
	instance = new InlineResults();
	context.subscriptions.push(
		instance,
		vscode.commands.registerCommand('julia.clearInlineResults', () => instance?.clearAll()),
	);
	return instance;
}

/**
 * Runs Julia code in the console as if typed there, and marks `target` with
 * its inline result when that feature is on. Resolves when the code has
 * finished. An error thrown by the code itself is shown in the console (and on
 * the marker), so it does not reject; failing to run the code at all does.
 */
export async function executeJuliaInConsole(
	code: string,
	target?: { document: vscode.TextDocument; lines: LineRange },
): Promise<void> {
	const marker = target ? instance?.observe(target.document, target.lines) : undefined;
	let failedInJulia = false;
	const observer: positron.runtime.ExecutionObserver = {
		...marker,
		onFailed: error => {
			failedInJulia = true;
			marker?.onFailed?.(error);
		},
	};
	try {
		await positron.runtime.executeCode(
			JULIA_LANGUAGE_ID,
			code,
			false,
			false,
			positron.RuntimeCodeExecutionMode.Interactive,
			positron.RuntimeErrorBehavior.Continue,
			observer,
		);
	} catch (error) {
		if (!failedInJulia) {
			throw error;
		}
	}
}

/**
 * Whether results for `document` are shown inline: Julia scripts, but not
 * notebook cells, which show their own execution status.
 */
function showsInlineResults(document: vscode.TextDocument): boolean {
	return document.languageId === JULIA_LANGUAGE_ID && document.uri.scheme !== 'vscode-notebook-cell';
}

function textPlain(data: Record<string, unknown> | undefined): string | undefined {
	const text = data?.['text/plain'];
	return typeof text === 'string' ? text : undefined;
}

function errorText(name: string | undefined, message: string | undefined): string {
	return message?.trim() ? message : (name ?? 'Error');
}

export class InlineResults implements vscode.Disposable {
	private enabled = false;
	private showValue = true;
	private decorationType: vscode.TextEditorDecorationType | undefined;

	/** Marks by document URI. */
	private readonly marks = new Map<string, Mark[]>();
	/** Executions awaiting their outcome, by execution ID. */
	private readonly executions = new Map<string, PendingExecution>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.readSettings();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(SETTINGS_SECTION)) {
					this.readSettings();
				}
			}),
			vscode.workspace.onDidChangeTextDocument(event => this.onDidChangeTextDocument(event)),
			vscode.workspace.onDidCloseTextDocument(document => this.clearDocument(document.uri.toString())),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) {
					this.render(editor);
				}
			}),
		);
	}

	dispose(): void {
		this.clearAll();
		this.decorationType?.dispose();
		this.decorationType = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		if (instance === this) {
			instance = undefined;
		}
	}

	private readSettings(): void {
		const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
		const enabled = config.get<boolean>('enabled', false);
		this.showValue = config.get<boolean>('showValue', true);

		if (enabled && !this.decorationType) {
			this.decorationType = vscode.window.createTextEditorDecorationType({
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			});
		} else if (!enabled && this.decorationType) {
			this.clearAll();
			this.decorationType.dispose();
			this.decorationType = undefined;
		}
		this.enabled = enabled;
		this.renderAll();
	}

	// ── Executions ──────────────────────────────────────────────────────

	/**
	 * Called by a Julia session for every execution. Marks the executed lines
	 * when Positron reports where the code came from (Ctrl+Enter / Cmd+Enter
	 * or a selection run in a Julia editor).
	 */
	onExecute(
		executionId: string,
		sessionId: string,
		mode: positron.RuntimeCodeExecutionMode,
		codeLocation: positron.Utf8Location | undefined,
	): void {
		if (!this.enabled || !codeLocation || mode === positron.RuntimeCodeExecutionMode.Silent) {
			return;
		}
		const uri = codeLocation.uri.toString();
		const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri);
		const lines = executedLineRange(codeLocation.range);
		if (!document || !showsInlineResults(document) || !lines) {
			return;
		}
		const mark = this.addMark(document, lines, sessionId);
		if (mark) {
			this.executions.set(executionId, { uri, mark });
		}
	}

	/** Called when an execution submitted with `onExecute` was rejected. */
	onExecuteRejected(executionId: string): void {
		const execution = this.executions.get(executionId);
		if (execution) {
			this.executions.delete(executionId);
			this.removeMark(execution.uri, execution.mark);
		}
	}

	/** Called with every runtime message of a Julia session. */
	onRuntimeMessage(message: positron.LanguageRuntimeMessage): void {
		const execution = this.executions.get(message.parent_id);
		if (!execution) {
			return;
		}
		switch (message.type) {
			case positron.LanguageRuntimeMessageType.Result:
				execution.result = textPlain((message as positron.LanguageRuntimeResult).data);
				break;
			case positron.LanguageRuntimeMessageType.Error: {
				const error = message as positron.LanguageRuntimeError;
				execution.error = errorText(error.name, error.message);
				break;
			}
			case positron.LanguageRuntimeMessageType.State:
				if ((message as positron.LanguageRuntimeState).state === positron.RuntimeOnlineState.Idle) {
					this.executions.delete(message.parent_id);
					this.finish(execution);
				}
				break;
		}
	}

	/** Called when a Julia session restarts or exits: its results are gone. */
	onSessionReset(sessionId: string): void {
		for (const [executionId, execution] of this.executions) {
			if (execution.mark.sessionId === sessionId) {
				this.executions.delete(executionId);
			}
		}
		for (const [uri, marks] of this.marks) {
			const kept = marks.filter(mark => mark.sessionId !== undefined && mark.sessionId !== sessionId);
			if (kept.length !== marks.length) {
				this.setMarks(uri, kept);
			}
		}
	}

	/**
	 * An observer for code this extension runs with
	 * `positron.runtime.executeCode`, marking `lines` of `document`. Returns
	 * undefined when inline results are off.
	 */
	observe(document: vscode.TextDocument, lines: LineRange): positron.runtime.ExecutionObserver | undefined {
		if (!this.enabled || !showsInlineResults(document)) {
			return undefined;
		}
		const mark = this.addMark(document, lines, undefined);
		if (!mark) {
			return undefined;
		}
		const execution: PendingExecution = { uri: document.uri.toString(), mark };
		return {
			onCompleted: result => {
				execution.result = textPlain(result);
				this.finish(execution);
			},
			onFailed: error => {
				execution.error = errorText(error?.name, error?.message);
				this.finish(execution);
			},
			onFinished: () => this.finish(execution),
		};
	}

	private finish(execution: PendingExecution): void {
		const mark = execution.mark;
		if (execution.error !== undefined) {
			mark.state = 'error';
			mark.output = execution.error;
		} else {
			mark.state = 'success';
			mark.output = execution.result;
		}
		if (this.marks.get(execution.uri)?.includes(mark)) {
			this.renderDocument(execution.uri);
		}
	}

	// ── Marks ───────────────────────────────────────────────────────────

	private addMark(document: vscode.TextDocument, lines: LineRange, sessionId: string | undefined): Mark | undefined {
		let endLine = Math.min(lines.endLine, document.lineCount - 1);
		// Put the marker on the last line with code, not on trailing blank lines.
		while (endLine > lines.startLine && document.lineAt(endLine).isEmptyOrWhitespace) {
			endLine--;
		}
		if (lines.startLine < 0 || endLine < lines.startLine) {
			return undefined;
		}
		const mark: Mark = {
			lines: { startLine: lines.startLine, endLine },
			state: 'running',
			sessionId,
			output: undefined,
		};
		const uri = document.uri.toString();
		// Running code again replaces the marks it overlaps.
		const kept = (this.marks.get(uri) ?? []).filter(other =>
			other.lines.endLine < mark.lines.startLine || other.lines.startLine > mark.lines.endLine);
		this.setMarks(uri, [...kept, mark]);
		return mark;
	}

	private removeMark(uri: string, mark: Mark): void {
		const marks = this.marks.get(uri);
		if (marks?.includes(mark)) {
			this.setMarks(uri, marks.filter(other => other !== mark));
		}
	}

	private setMarks(uri: string, marks: Mark[]): void {
		if (marks.length > 0) {
			this.marks.set(uri, marks);
		} else {
			this.marks.delete(uri);
		}
		this.renderDocument(uri);
	}

	private clearDocument(uri: string): void {
		if (this.marks.has(uri)) {
			this.setMarks(uri, []);
		}
	}

	/** Removes every marker ("Julia: Clear Inline Results"). */
	clearAll(): void {
		this.executions.clear();
		for (const uri of [...this.marks.keys()]) {
			this.setMarks(uri, []);
		}
	}

	private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
		const uri = event.document.uri.toString();
		const marks = this.marks.get(uri);
		if (!marks || event.contentChanges.length === 0) {
			return;
		}
		// Apply the changes bottom-up so each one's line numbers are still
		// valid for the marks above it.
		const changes: TextChange[] = [...event.contentChanges]
			.sort((a, b) => b.range.start.compareTo(a.range.start));
		const lineTextAfter = changes.length === 1
			? (line: number) => line < event.document.lineCount ? event.document.lineAt(line).text : undefined
			: undefined;

		const kept: Mark[] = [];
		let moved = false;
		for (const mark of marks) {
			let lines: LineRange | undefined = mark.lines;
			for (const change of changes) {
				lines = lines && adjustRangeForEdit(lines, change, lineTextAfter);
			}
			if (lines) {
				moved ||= lines.startLine !== mark.lines.startLine || lines.endLine !== mark.lines.endLine;
				mark.lines = lines;
				kept.push(mark);
			}
		}
		if (moved || kept.length !== marks.length) {
			this.setMarks(uri, kept);
		}
	}

	// ── Rendering ───────────────────────────────────────────────────────

	private renderAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.render(editor);
		}
	}

	private renderDocument(uri: string): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uri) {
				this.render(editor);
			}
		}
	}

	private render(editor: vscode.TextEditor): void {
		if (!this.decorationType) {
			return;
		}
		const marks = this.marks.get(editor.document.uri.toString()) ?? [];
		const decorations: vscode.DecorationOptions[] = [];
		for (const mark of marks) {
			const decoration = this.decoration(editor.document, mark);
			if (decoration) {
				decorations.push(decoration);
			}
		}
		editor.setDecorations(this.decorationType, decorations);
	}

	private decoration(document: vscode.TextDocument, mark: Mark): vscode.DecorationOptions | undefined {
		if (mark.lines.endLine >= document.lineCount) {
			return undefined;
		}
		const end = document.lineAt(mark.lines.endLine).range.end;

		// `before` and `after` injected text at the same position always render
		// in that order: the status symbol, then the preview.
		const renderOptions: vscode.DecorationInstanceRenderOptions = {
			before: {
				contentText: mark.state === 'running' ? '⋯' : mark.state === 'success' ? '✓' : '✗',
				color: new vscode.ThemeColor(
					mark.state === 'running' ? 'editorCodeLens.foreground'
						: mark.state === 'success' ? 'testing.iconPassed' : 'testing.iconFailed'),
				margin: '0 0 0 1.5em',
			},
		};

		const preview = this.showValue && mark.output ? previewText(mark.output, MAX_PREVIEW_LENGTH) : '';
		if (preview) {
			renderOptions.after = {
				contentText: preview,
				color: new vscode.ThemeColor(mark.state === 'error' ? 'editorError.foreground' : 'editorCodeLens.foreground'),
				margin: '0 0 0 0.6em',
			};
		}

		let hoverMessage: vscode.MarkdownString | undefined;
		if (mark.output?.trim()) {
			hoverMessage = new vscode.MarkdownString();
			hoverMessage.appendCodeblock(truncateText(mark.output, MAX_HOVER_LENGTH), 'text');
		}

		return { range: new vscode.Range(end, end), renderOptions, hoverMessage };
	}
}
