/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Mocha entry point for the Positron-only integration tests. This module is
// loaded inside the Positron extension host by @posit-dev/positron-test-electron
// (see scripts/run-positron-tests.mjs), which requires it and calls run().
//
// These tests are kept separate from the Julia-side unit tests
// (julia/Positron/test/) because they exercise the TypeScript extension's
// integration with the Positron API, which is only available when the tests run
// inside a real Positron build rather than plain Node or vanilla VS Code.

import * as fs from 'fs';
import * as path from 'path';

// `import =` so the compiled output is a plain `require`: mocha is a CommonJS
// constructor and the ESM-interop namespace produced by `import * as` is not
// constructable.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Mocha = require('mocha');

export function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		// Extension activation and Julia runtime discovery on a cold CI machine
		// can be slow, so give each test a generous ceiling.
		timeout: 120000,
	});

	const testsRoot = __dirname;
	for (const file of fs.readdirSync(testsRoot)) {
		if (file.endsWith('.test.js')) {
			mocha.addFile(path.resolve(testsRoot, file));
		}
	}

	return new Promise((resolve, reject) => {
		try {
			mocha.run((failures) => {
				if (failures > 0) {
					reject(new Error(`${failures} test(s) failed.`));
				} else {
					resolve();
				}
			});
		} catch (err) {
			reject(err);
		}
	});
}
