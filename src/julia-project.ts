/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which Julia project is active for a workspace. The status bar, the console
 * kernel and the language server all resolve it here, so they agree
 * (issue #29).
 *
 * The search for a `Project.toml` never leaves the workspace: a folder opened
 * inside some other project uses the global environment until the user
 * explicitly picks a project, which is stored in
 * `positron.julia.languageServer.environmentPath`.
 *
 * No dependency on `vscode` or `positron`, so it can be unit tested under
 * plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface JuliaProjectResolution {
	/** The project directory, or undefined for the global environment. */
	readonly path: string | undefined;
	/**
	 * The user chose this directory explicitly: activate it even if it has no
	 * `Project.toml` yet (the first `Pkg.add` creates one).
	 */
	readonly explicit: boolean;
	/** Why this project was chosen, for logs. */
	readonly reason: string;
	/** A configured project that was ignored because it does not exist. */
	readonly missingSetting?: string;
}

export interface JuliaProjectInput {
	/** Raw `positron.julia.languageServer.environmentPath` (may be relative). */
	readonly configuredPath?: string;
	/** Workspace folder paths, first one first. */
	readonly workspaceRoots: readonly string[];
	/**
	 * Start the search from this file's folder instead of the first workspace
	 * root, when the file is inside a workspace root.
	 */
	readonly activeFile?: string;
	readonly exists?: (p: string) => boolean;
}

/** Whether `dir` holds a Julia project file. */
export function hasJuliaProjectFile(dir: string, exists: (p: string) => boolean = fs.existsSync): boolean {
	return exists(path.join(dir, 'Project.toml')) || exists(path.join(dir, 'JuliaProject.toml'));
}

function isInside(root: string, p: string): boolean {
	const relative = path.relative(root, p);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveJuliaProject(input: JuliaProjectInput): JuliaProjectResolution {
	const exists = input.exists ?? fs.existsSync;
	const firstRoot = input.workspaceRoots[0];

	let missingSetting: string | undefined;
	const configured = input.configuredPath?.trim();
	if (configured) {
		const resolved = path.isAbsolute(configured)
			? configured
			: path.resolve(firstRoot ?? process.cwd(), configured);
		if (exists(resolved)) {
			return {
				path: resolved,
				explicit: true,
				reason: 'user setting (positron.julia.languageServer.environmentPath)',
			};
		}
		missingSetting = resolved;
	}

	// Search upward from the active file's folder, or from the first root,
	// but never above the workspace root it started in.
	let start: string | undefined;
	let root: string | undefined;
	if (input.activeFile) {
		root = input.workspaceRoots
			.filter(r => isInside(r, input.activeFile!))
			.sort((a, b) => b.length - a.length)[0];
		start = root ? path.dirname(input.activeFile) : undefined;
	}
	if (!start && firstRoot) {
		start = root = firstRoot;
	}
	if (start && root) {
		for (let dir = start; isInside(root, dir); dir = path.dirname(dir)) {
			if (hasJuliaProjectFile(dir, exists)) {
				return {
					path: dir,
					explicit: false,
					reason: dir === start ? `project at ${dir}` : `nearest project above ${start}`,
					missingSetting,
				};
			}
			if (dir === root) {
				break;
			}
		}
	}

	return { path: undefined, explicit: false, reason: 'global environment (no project in the workspace)', missingSetting };
}
