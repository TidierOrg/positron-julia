/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Positron-only integration test.
//
// Exercises this extension's central Positron integration end-to-end through
// the live API. On activation the extension registers a Julia
// LanguageRuntimeManager (positron.runtime.registerLanguageRuntimeManager, see
// src/extension.ts); Positron then drives JuliaRuntimeManager.discoverAllRuntimes
// (src/runtime-manager.ts), which builds metadata via createJuliaRuntimeMetadata
// (src/runtime.ts). We assert that a Julia runtime surfaces in Positron's own
// runtime registry with the expected shape.
//
// Discovery only yields a runtime when a real Julia is on PATH, so CI installs
// one via julia-actions/setup-julia before running this suite.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as positron from 'positron';

/** Extension identifier: package.json `publisher`.`name`. */
const EXTENSION_ID = 'ntluong95.positron-julia';

/**
 * Poll `fn` until it returns a truthy value or the timeout elapses. Runtime
 * discovery is asynchronous (an async generator that shells out to locate Julia
 * installations), so registered runtimes appear some time after activation
 * rather than synchronously.
 */
async function pollFor<T>(
	fn: () => Thenable<T | undefined>,
	{ timeoutMs = 60000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await fn();
		if (result) {
			return result;
		}
		if (Date.now() >= deadline) {
			return undefined;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

suite('Positron: Julia runtime registration', () => {
	suiteSetup(async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `${EXTENSION_ID} should be present in the extension host`);
		await ext.activate();
	});

	test('a Julia runtime is registered with Positron', async () => {
		const juliaRuntimes = await pollFor(async () => {
			const runtimes = await positron.runtime.getRegisteredRuntimes();
			const julia = runtimes.filter((runtime) => runtime.languageId === 'julia');
			return julia.length > 0 ? julia : undefined;
		});

		assert.ok(
			juliaRuntimes && juliaRuntimes.length > 0,
			'the extension should register at least one Julia runtime with Positron'
		);

		// Shape check against what createJuliaRuntimeMetadata (src/runtime.ts) emits.
		const metadata = juliaRuntimes[0];
		assert.strictEqual(metadata.languageId, 'julia');
		assert.strictEqual(metadata.languageName, 'Julia');
		assert.ok(metadata.runtimeId.length > 0, 'runtime metadata should carry a runtimeId');
		assert.ok(metadata.runtimePath.length > 0, 'runtime metadata should carry a runtimePath');
	});

	test('getPreferredRuntime resolves a Julia runtime', async () => {
		const preferred = await pollFor(() => positron.runtime.getPreferredRuntime('julia'));

		assert.ok(preferred, 'Positron should resolve a preferred Julia runtime');
		assert.strictEqual(preferred.languageId, 'julia');
	});
});
