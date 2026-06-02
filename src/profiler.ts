/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'fs/promises';

import { LOGGER } from './extension';

interface ProfilerFrame {
	func: string;
	file: string;
	path: string;
	line: number;
	count: number;
	countLabel?: number | string;
	flags: number;
	children: ProfilerFrame[];
}

interface ProfileRoot {
	data: Record<string, ProfilerFrame>;
	type: string;
}

interface InlineTraceElement {
	path: string;
	line: number;
	fraction: number;
	count: number;
	countLabel?: number | string;
	flags: number;
}

function flagString(flags: number): string {
	let out = '';
	if (flags & 0x01) { out += 'GC'; }
	if (flags & 0x02) { out += ' dispatch'; }
	if (flags & 0x08) { out += ' compilation'; }
	if (flags & 0x10) { out += ' task'; }
	return out === '' ? '' : '\n\n Flags: ' + out;
}

const PROFILER_FOCUS_CONTEXT = 'julia.profilerFocus';

/**
 * Manages the Julia profiler webview, the profile history, and the inline
 * sample-fraction decorations on open editors.
 */
export class ProfilerFeature implements vscode.Disposable {
	private readonly _context: vscode.ExtensionContext;
	private _panel: vscode.WebviewPanel | undefined;

	private _profiles: ProfileRoot[] = [];
	private _inlineTrace: InlineTraceElement[] = [];
	private _decoration: vscode.TextEditorDecorationType | undefined;
	private _currentProfileIndex = 0;
	private _selection: string = 'all';

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this._context = context;

		const register = (id: string, fn: (...args: any[]) => any) => {
			this._disposables.push(vscode.commands.registerCommand(id, fn));
		};

		register('julia.openProfiler', () => this.show());
		register('julia.nextProfile', () => this.next());
		register('julia.previousProfile', () => this.previous());
		register('julia.deleteProfile', () => this.delete());
		register('julia.deleteAllProfiles', () => this.deleteAll());
		register('julia.saveProfileToFile', () => this.saveToFile());

		this._disposables.push(
			vscode.window.onDidChangeVisibleTextEditors((editors) =>
				this.refreshInlineTrace(editors),
			),
		);
	}

	dispose(): void {
		if (this._panel) {
			this._panel.dispose();
		}
		this.clearInlineTrace();
		for (const d of this._disposables) {
			try { d.dispose(); } catch { /* ignore */ }
		}
		this._disposables.length = 0;
	}

	/**
	 * Public entry point: append a new trace and reveal it. Called by the
	 * session when a `positron.profile` comm delivers data.
	 */
	showTrace(trace: ProfileRoot): void {
		this._profiles.push(trace);
		this._currentProfileIndex = this._profiles.length - 1;
		this.show();
	}

	private clearInlineTrace(): void {
		this._inlineTrace = [];
		if (this._decoration) {
			this._decoration.dispose();
			this._decoration = undefined;
		}
	}

	private setInlineTrace(profile: Record<string, ProfilerFrame>): void {
		this.clearInlineTrace();
		this._decoration = vscode.window.createTextEditorDecorationType({
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			isWholeLine: true,
		});

		const root = profile[this._selection];
		if (!root) { return; }

		this.buildInlineTraceElements(root, root.count);
		this.refreshInlineTrace(vscode.window.visibleTextEditors);
	}

	private buildInlineTraceElements(node: ProfilerFrame, rootCount: number): void {
		this._inlineTrace.push({
			path: node.path,
			line: node.line,
			count: node.count,
			countLabel: node.countLabel,
			fraction: rootCount === 0 ? 0 : node.count / rootCount,
			flags: node.flags,
		});

		for (const child of node.children) {
			this.buildInlineTraceElements(child, rootCount);
		}
	}

	private inlineTraceColor(flags: number): vscode.ThemeColor {
		if (flags & 0x01) {
			return new vscode.ThemeColor('julia.profiler.dispatch');
		}
		if (flags & 0x02) {
			return new vscode.ThemeColor('julia.profiler.gc');
		}
		return new vscode.ThemeColor('julia.profiler.default');
	}

	private collateTrace(editors: readonly vscode.TextEditor[]): Record<string, Record<number, any>> {
		const edHighlights: Record<string, Record<number, any>> = {};
		for (const highlight of this._inlineTrace) {
			for (const editor of editors) {
				const uri = editor.document.uri.toString();
				if (!highlight.path) { continue; }
				if (uri !== vscode.Uri.file(highlight.path).toString()) { continue; }

				if (edHighlights[uri] === undefined) {
					edHighlights[uri] = {};
				}
				const line = Math.max(0, highlight.line - 1);
				const existing = edHighlights[uri][line];
				const count = (existing?.count ?? 0) + highlight.count;
				const fraction = (existing?.fraction ?? 0) + highlight.fraction;
				const flags = (existing?.flags ?? 0) | highlight.flags;

				const hoverMessage =
					(highlight.countLabel?.toString() ?? `${count} samples`) +
					` (${(fraction * 100).toFixed()}%) ${flagString(flags)}`;

				edHighlights[uri][line] = {
					count,
					fraction,
					flags,
					range: new vscode.Range(
						new vscode.Position(line, 0),
						new vscode.Position(line, 0),
					),
					hoverMessage,
					renderOptions: {
						before: {
							contentText: ' ',
							backgroundColor: this.inlineTraceColor(flags),
							width: fraction * 20 + 'em',
							textDecoration:
								'none; white-space: pre; position: absolute; pointer-events: none',
						},
					},
				};
			}
		}
		return edHighlights;
	}

	private refreshInlineTrace(editors: readonly vscode.TextEditor[]): void {
		if (editors.length === 0 || !this._decoration) { return; }
		const edHighlights = this.collateTrace(editors);

		for (const editor of editors) {
			const uri = editor.document.uri.toString();
			if (edHighlights[uri]) {
				const highlights = Object.values(edHighlights[uri]);
				editor.setDecorations(this._decoration, highlights);
			}
		}
	}

	private async openSourceFromProfile(node: ProfilerFrame): Promise<void> {
		if (!node?.path) { return; }
		try {
			const targetColumn =
				this._panel?.viewColumn === vscode.ViewColumn.Two
					? vscode.ViewColumn.One
					: vscode.ViewColumn.Beside;
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.path));
			const editor = await vscode.window.showTextDocument(document, {
				preserveFocus: false,
				viewColumn: targetColumn,
			});
			const line = Math.max(0, node.line - 1);
			const position = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(position, position),
				vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			);
		} catch (error) {
			LOGGER.warn(`Failed to open profile source ${node.path}: ${error}`);
		}
	}

	private async createPanel(): Promise<void> {
		if (this._panel) { return; }

		this._panel = vscode.window.createWebviewPanel(
			'jlprofilerpane',
			this.makeTitle(),
			{
				preserveFocus: true,
				viewColumn: this._context.globalState.get<vscode.ViewColumn>(
					'juliaProfilerViewColumn',
					vscode.ViewColumn.Two,
				),
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(this._context.extensionPath, 'libs', 'jl-profile', 'dist')),
				],
			},
		);

		let resolveLoaded: () => void = () => undefined;
		const loadedPromise = new Promise<void>((resolve) => {
			resolveLoaded = resolve;
		});

		const messageHandler = this._panel.webview.onDidReceiveMessage(
			(message: { type: string; node?: ProfilerFrame; selection?: string }) => {
				if (message.type === 'open' && message.node) {
					this.openSourceFromProfile(message.node);
				} else if (message.type === 'selectionChange' && message.selection) {
					this._selection = message.selection;
					const current = this._profiles[this._currentProfileIndex];
					if (current) {
						this.setInlineTrace(current.data);
					}
				} else if (message.type === 'profilerLoaded') {
					resolveLoaded();
				} else {
					LOGGER.warn(`Unknown profiler webview message: ${message.type}`);
				}
			},
		);

		this._panel.webview.html = this.getWebviewContent(this._panel.webview);
		await loadedPromise;

		const viewStateListener = this._panel.onDidChangeViewState(({ webviewPanel }) => {
			this._context.globalState.update('juliaProfilerViewColumn', webviewPanel.viewColumn);
			vscode.commands.executeCommand('setContext', PROFILER_FOCUS_CONTEXT, webviewPanel.active);
		});

		this._panel.onDidDispose(() => {
			viewStateListener.dispose();
			messageHandler.dispose();
			vscode.commands.executeCommand('setContext', PROFILER_FOCUS_CONTEXT, false);
			this._panel = undefined;
			this.clearInlineTrace();
		});
	}

	private async show(): Promise<void> {
		this._selection = 'all';
		await this.createPanel();
		if (!this._panel) { return; }

		this._panel.title = this.makeTitle();

		if (this.profileCount > 0) {
			const profile = this._profiles[this._currentProfileIndex];
			this._panel.webview.postMessage(profile);
			this._selection = Object.keys(profile.data)[0] ?? 'all';
			this.setInlineTrace(profile.data);
		} else {
			this._panel.webview.postMessage(null);
			this.clearInlineTrace();
		}

		if (!this._panel.visible) {
			this._panel.reveal(this._panel.viewColumn, true);
		}
	}

	private previous(): void {
		if (this._currentProfileIndex > 0) {
			this._currentProfileIndex -= 1;
			this.show();
		}
	}

	private next(): void {
		if (this._currentProfileIndex < this._profiles.length - 1) {
			this._currentProfileIndex += 1;
			this.show();
		}
	}

	private delete(): void {
		if (this._profiles.length === 0) { return; }
		this._profiles.splice(this._currentProfileIndex, 1);
		this._currentProfileIndex = Math.min(
			this._currentProfileIndex,
			this._profiles.length - 1,
		);
		if (this._currentProfileIndex < 0) {
			this._currentProfileIndex = 0;
		}
		this.show();
	}

	private deleteAll(): void {
		this._profiles = [];
		this._currentProfileIndex = 0;
		this.show();
	}

	private profileViewerJSPath(): string {
		return path.join(
			this._context.extensionPath,
			'libs',
			'jl-profile',
			'dist',
			'profile-viewer.js',
		);
	}

	private getWebviewContent(webview: vscode.Webview): string {
		const profilerURL = webview.asWebviewUri(vscode.Uri.file(this.profileViewerJSPath()));

		return `
		<!DOCTYPE html>
		<html lang="en">
			<head>
			<meta charset="utf-8" />
			<style>
			body {
				width: 100vw;
				height: 100vh;
				padding: 0;
				margin: 0;
			}
			#profiler-container {
				padding: 0;
				margin: 0;
				position: absolute;
				top: 0;
				left: 0;
				bottom: 0;
				right: 0;
				overflow: hidden;
			}
			select {
				color: var(--vscode-input-foreground);
				background: var(--vscode-input-background);
				border: 1px solid var(--vscode-searchEditor-textInputBorder);
				border-radius: 0;
				font-size: inherit;
				padding: 0.125rem 0.5rem;
				height: calc(1.5em + 0.25rem + 2px);
				margin-left: 0.5rem;
			}
			button {
				display: inline;
				text-decoration: none;
				border: none;
				box-sizing: border-box;
				text-align: center;
				cursor: pointer;
				justify-content: center;
				align-items: center;
				color: var(--vscode-textLink-foreground);
				background: none;
				font-family: var(--vscode-font-family);
				font-size: 1em;
			}
			#profiler-container .__profiler-filter {
				border-bottom: 1px solid var(--vscode-panel-border);
			}
			#profiler-container .__profiler-tooltip {
				background-color: var(--vscode-editorHoverWidget-background);
				border: 1px solid var(--vscode-editorHoverWidget-border);
				font-size: 1em !important;
			}
			</style>
		</head>
		<body>
			<div id="profiler-container"></div>
			<script type="text/javascript">
				const vscode = acquireVsCodeApi();
				const container = document.getElementById("profiler-container");

				import('${profilerURL}').then(({ProfileViewer}) => {
					const prof = new ProfileViewer(container);
					prof.registerCtrlClickHandler((node) => {
						vscode.postMessage({ type: "open", node: node });
					});
					prof.registerSelectionHandler((selection) => {
						vscode.postMessage({ type: "selectionChange", selection: selection });
					});

					window.addEventListener("message", (event) => {
						if (event.data) {
							prof.setData(event.data.data);
							prof.setSelectorLabel(event.data.type);
						} else {
							prof.setData(null);
						}
					});
					vscode.postMessage({ type: "profilerLoaded" });
				});
			</script>
		</body>
		</html>
		`;
	}

	private async saveToFile(): Promise<void> {
		if (this._profiles.length === 0 || !this._profiles[this._currentProfileIndex]) {
			vscode.window.showErrorMessage('No profile trace recorded.');
			return;
		}

		let defaultUri = vscode.workspace.workspaceFolders
			? vscode.workspace.workspaceFolders[0]?.uri
			: undefined;
		if (defaultUri) {
			defaultUri = defaultUri.with({ path: defaultUri.path + '/profile.html' });
		}

		const savePath = await vscode.window.showSaveDialog({
			title: 'Save Profile Trace',
			filters: { HTML: ['html'] },
			defaultUri,
		});
		if (!savePath) { return; }

		const jsProfileScript = await readFile(this.profileViewerJSPath());
		const jsProfileDataUrl =
			'data:text/javascript;base64,' + Buffer.from(jsProfileScript).toString('base64');

		const profile = this._profiles[this._currentProfileIndex];
		await writeFile(
			savePath.fsPath,
			`
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Profile Trace</title>
			<style>
			#profiler-container {
				margin: 0;
				padding: 0;
				width: 100vw;
				height: 100vh;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
			}
			body {
				margin: 0;
				padding: 0;
				width: 100vw;
				height: 100vh;
				overflow: hidden;
			}
			</style>
		</head>
		<body>
			<div id="profiler-container"></div>
			<script type="text/javascript">
				const container = document.getElementById("profiler-container");
				import('${jsProfileDataUrl}').then(({ProfileViewer}) => {
					const prof = new ProfileViewer(container);
					prof.setData(${JSON.stringify(profile.data)});
					prof.setSelectorLabel(${JSON.stringify(profile.type)});
				});
			</script>
		</body>
		</html>
		`,
		);
	}

	get profileCount(): number {
		return this._profiles.length;
	}

	private makeTitle(): string {
		return `Profiler (${this._currentProfileIndex + 1}/${this.profileCount})`;
	}
}
