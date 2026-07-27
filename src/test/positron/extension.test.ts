/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Positron-only integration test.
//
// Baseline checks for the contract the extension depends on when it runs inside
// Positron: the `positron` API module is provided to the extension host (the
// extension imports it in ~15 source files, e.g. src/extension.ts), and the
// Julia extension activates in that host.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as positron from 'positron';

/** Extension identifier: package.json `publisher`.`name`. */
const EXTENSION_ID = 'ntluong95.positron-julia';

suite('Positron: extension host', () => {
	test('the positron API module is available in the extension host', () => {
		assert.ok(positron, 'the `positron` module should be importable inside Positron');
		assert.strictEqual(typeof positron.version, 'string', 'positron.version should be a string');
		assert.ok(positron.version.length > 0, 'Positron should report a non-empty version');
	});

	test('the Julia extension activates in Positron', async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `${EXTENSION_ID} should be present in the extension host`);

		await ext.activate();
		assert.ok(ext.isActive, 'the Julia extension should activate without error');
	});
});
