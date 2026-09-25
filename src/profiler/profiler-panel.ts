/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The flame graph webview. Renders profiles with jl-profile.js (vendored in
 * `resources/profiler`, see its NOTICE), the renderer julia-vscode uses.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { Profile, ProfileFrame } from './profile-store';

/** Messages the webview sends to the extension. */
type ViewerMessage =
	| { type: 'loaded' }
	| { type: 'open'; node: Pick<ProfileFrame, 'path' | 'line'> };

export class ProfilerPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private loaded: Promise<void> | undefined;

	constructor(private readonly extensionUri: vscode.Uri) { }

	/** Shows `profile` (or an empty viewer) with `title`, creating the panel if needed. */
	async show(profile: Profile | undefined, title: string): Promise<void> {
		if (!this.panel) {
			this.create();
		}
		await this.loaded;
		const panel = this.panel!;
		panel.title = title;
		await panel.webview.postMessage(profile ?? null);
		if (!panel.visible) {
			panel.reveal(panel.viewColumn, true);
		}
	}

	get isOpen(): boolean {
		return this.panel !== undefined;
	}

	private create(): void {
		const resources = vscode.Uri.joinPath(this.extensionUri, 'resources', 'profiler');
		const panel = vscode.window.createWebviewPanel(
			'juliaProfiler',
			'Julia Profile',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] },
		);
		this.panel = panel;

		let markLoaded: () => void = () => { };
		this.loaded = new Promise(resolve => { markLoaded = resolve; });

		panel.webview.onDidReceiveMessage((message: ViewerMessage) => {
			if (message.type === 'loaded') {
				markLoaded();
			} else if (message.type === 'open') {
				void openFrame(message.node, panel.viewColumn);
			}
		});
		panel.onDidDispose(() => {
			this.panel = undefined;
			this.loaded = undefined;
		});

		const viewerUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'profile-viewer.js'));
		panel.webview.html = viewerHtml(panel.webview.cspSource, viewerUri.toString(), crypto.randomBytes(16).toString('base64'));
	}

	dispose(): void {
		this.panel?.dispose();
	}
}

/**
 * Opens the source line of a clicked frame. The path comes from the profile,
 * so it is only opened when it names an existing file (Base frames often
 * point to build-machine paths).
 */
async function openFrame(node: Pick<ProfileFrame, 'path' | 'line'>, panelColumn: vscode.ViewColumn | undefined): Promise<void> {
	if (typeof node?.path !== 'string' || !node.path || typeof node.line !== 'number') {
		return;
	}
	try {
		if (!fs.statSync(node.path).isFile()) {
			return;
		}
	} catch {
		vscode.window.showInformationMessage(`Source not found: ${node.path}`);
		return;
	}
	const line = Math.max(0, node.line - 1);
	await vscode.window.showTextDocument(vscode.Uri.file(node.path), {
		selection: new vscode.Range(line, 0, line, 0),
		viewColumn: panelColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
	});
}

function viewerHtml(cspSource: string, viewerUri: string, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource};">
	<style>
		body { width: 100vw; height: 100vh; padding: 0; margin: 0; }
		#profiler-container { position: absolute; inset: 0; overflow: hidden; }
		select {
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-searchEditor-textInputBorder);
			border-radius: 0;
			font-size: inherit;
			padding: 0.125rem 0.5rem;
			margin-left: 0.5rem;
		}
		button {
			border: none;
			cursor: pointer;
			color: var(--vscode-textLink-foreground);
			background: none;
			font-family: var(--vscode-font-family);
			font-size: 1em;
		}
		#profiler-container .__profiler-filter { border-bottom: 1px solid var(--vscode-panel-border); }
		#profiler-container .__profiler-tooltip {
			background-color: var(--vscode-editorHoverWidget-background);
			border: 1px solid var(--vscode-editorHoverWidget-border);
			font-size: 1em !important;
		}
	</style>
</head>
<body>
	<div id="profiler-container"></div>
	<script nonce="${nonce}" type="module">
		const vscode = acquireVsCodeApi();
		const { ProfileViewer } = await import(${JSON.stringify(viewerUri)});
		const viewer = new ProfileViewer(document.getElementById('profiler-container'));
		// Ctrl/Cmd+click on a frame opens its source line.
		viewer.registerCtrlClickHandler(node => vscode.postMessage({ type: 'open', node: { path: node.path, line: node.line } }));
		window.addEventListener('message', event => {
			if (event.data) {
				viewer.setData(event.data.data);
				viewer.setSelectorLabel(event.data.type);
			} else {
				viewer.setData(null);
			}
		});
		vscode.postMessage({ type: 'loaded' });
	</script>
</body>
</html>`;
}
