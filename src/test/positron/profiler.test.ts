/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Positron-only integration test for the Julia profiler (issue #14): the whole
// path from `@profview` in a Julia session, over the `positron.profile` comm,
// to the flame graph panel.
//
// It starts a real Julia kernel, whose first start installs and precompiles
// the kernel's packages, so it is opt-in: set POSITRON_JULIA_SESSION_TESTS=1.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as positron from 'positron';

const EXTENSION_ID = 'ntluong95.positron-julia';

async function pollFor<T>(
	fn: () => T | undefined | Thenable<T | undefined>,
	{ timeoutMs = 120000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {}
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

function tabLabeled(label: string): vscode.Tab | undefined {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label === label);
}

suite('Positron: Julia profiler', function () {
	// Starting a Julia kernel (and precompiling on a fresh machine) is slow.
	this.timeout(10 * 60 * 1000);

	let session: positron.LanguageRuntimeSession | undefined;

	suiteSetup(async function () {
		if (process.env.POSITRON_JULIA_SESSION_TESTS !== '1') {
			this.skip();
		}
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `${EXTENSION_ID} should be present in the extension host`);
		await ext.activate();
	});

	suiteTeardown(async () => {
		await session?.shutdown(positron.RuntimeExitReason.Shutdown);
	});

	test('@profview in a Julia session opens the flame graph', async () => {
		const runtime = await pollFor(() => positron.runtime.getPreferredRuntime('julia'));
		assert.ok(runtime, 'a Julia runtime should be available');
		session = await positron.runtime.startLanguageRuntime(runtime.runtimeId, 'Profiler test');

		// Keep the result so the work cannot be optimized away (no samples).
		await positron.runtime.executeCode('julia', [
			'const __profile_sink = Ref(0.0)',
			'__profile_work(n) = sum(sqrt(i) for i in 1:n)',
			'__profile_loop(k) = for _ in 1:k; __profile_sink[] += __profile_work(10^6); end',
			'__profile_loop(1)',
			'Positron.@profview __profile_loop(400)',
		].join('\n'), false);

		const tab = await pollFor(() => tabLabeled('Julia Profile 1 of 1'), { timeoutMs: 60000 });
		assert.ok(tab, 'the flame graph panel should open with the profile');
	});
});
