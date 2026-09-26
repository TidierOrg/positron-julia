/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the shared Julia project resolver (issue #29).
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';
import * as path from 'path';

import { resolveJuliaProject } from '../../julia-project';

const p = (...parts: string[]) => path.join('/w', ...parts);

/** A fake filesystem holding exactly `files`. */
function fsWith(...files: string[]): (f: string) => boolean {
	const set = new Set(files);
	return f => set.has(f) || [...set].some(x => x.startsWith(f + path.sep)); // dirs exist implicitly
}

suite('Julia project resolution (issue #29)', () => {

	test('a folder opened inside another project does not inherit it', () => {
		// ~/proj has a Project.toml; the user opened ~/proj/sub, which has none.
		const exists = fsWith(p('proj', 'Project.toml'), p('proj', 'sub', 'script.jl'));
		const r = resolveJuliaProject({ workspaceRoots: [p('proj', 'sub')], exists });
		assert.strictEqual(r.path, undefined);
		assert.strictEqual(r.explicit, false);
	});

	test('the workspace root project is used', () => {
		const exists = fsWith(p('proj', 'Project.toml'));
		const r = resolveJuliaProject({ workspaceRoots: [p('proj')], exists });
		assert.strictEqual(r.path, p('proj'));
		assert.strictEqual(r.explicit, false);
	});

	test('JuliaProject.toml counts as a project', () => {
		const exists = fsWith(p('proj', 'JuliaProject.toml'));
		assert.strictEqual(resolveJuliaProject({ workspaceRoots: [p('proj')], exists }).path, p('proj'));
	});

	test('the setting wins and is explicit, even without Project.toml', () => {
		const exists = fsWith(p('proj', 'Project.toml'), p('proj', 'new', 'README.md'));
		const r = resolveJuliaProject({ configuredPath: p('proj', 'new'), workspaceRoots: [p('proj')], exists });
		assert.strictEqual(r.path, p('proj', 'new'));
		assert.strictEqual(r.explicit, true);
	});

	test('a relative setting resolves against the first workspace root', () => {
		const exists = fsWith(p('proj', 'env', 'Project.toml'));
		const r = resolveJuliaProject({ configuredPath: 'env', workspaceRoots: [p('proj')], exists });
		assert.strictEqual(r.path, p('proj', 'env'));
	});

	test('a missing setting is reported and ignored', () => {
		const exists = fsWith(p('proj', 'Project.toml'));
		const r = resolveJuliaProject({ configuredPath: p('gone'), workspaceRoots: [p('proj')], exists });
		assert.strictEqual(r.path, p('proj'));
		assert.strictEqual(r.missingSetting, p('gone'));
	});

	test('from an active file: its nearest project inside the workspace', () => {
		const exists = fsWith(p('mono', 'pkgA', 'Project.toml'), p('mono', 'pkgA', 'src', 'A.jl'));
		const r = resolveJuliaProject({
			workspaceRoots: [p('mono')], activeFile: p('mono', 'pkgA', 'src', 'A.jl'), exists,
		});
		assert.strictEqual(r.path, p('mono', 'pkgA'));
	});

	test('from an active file: the search stops at the workspace root', () => {
		const exists = fsWith(p('proj', 'Project.toml'), p('proj', 'sub', 'a', 'x.jl'));
		const r = resolveJuliaProject({
			workspaceRoots: [p('proj', 'sub')], activeFile: p('proj', 'sub', 'a', 'x.jl'), exists,
		});
		assert.strictEqual(r.path, undefined);
	});

	test('an active file outside the workspace is ignored', () => {
		const exists = fsWith(p('other', 'Project.toml'), p('other', 'x.jl'), p('proj', 'Project.toml'));
		const r = resolveJuliaProject({ workspaceRoots: [p('proj')], activeFile: p('other', 'x.jl'), exists });
		assert.strictEqual(r.path, p('proj'));
	});

	test('no workspace and no setting: global', () => {
		const exists = fsWith(p('x', 'Project.toml'), p('x', 'f.jl'));
		const r = resolveJuliaProject({ workspaceRoots: [], activeFile: p('x', 'f.jl'), exists });
		assert.strictEqual(r.path, undefined);
	});
});
