/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Making sure every test in a run ends with a result (issue #19). A test whose
 * process crashes may never be reported; ending the run without a result for
 * it is easy to misread as success, so such tests are marked errored with the
 * crashed process's last output.
 *
 * No dependency on `vscode`, so it can be unit tested under plain Node.
 */

/** Tests of a run that have not been reported yet. */
export interface PendingTests<Item> {
	readonly testItems: ReadonlyMap<string, Item>;
	readonly pendingItems: Set<string>;
}

/** Gives every pending test a result via `settle`, and clears the pending set. */
export function settlePendingItems<Item>(run: PendingTests<Item>, settle: (item: Item) => void): number {
	let settled = 0;
	for (const id of run.pendingItems) {
		const item = run.testItems.get(id);
		if (item) {
			settle(item);
			settled++;
		}
	}
	run.pendingItems.clear();
	return settled;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The last `maxLines` lines of a stream of output chunks, without ANSI colors. */
export class OutputTail {
	private readonly lines: string[] = [''];

	constructor(private readonly maxLines = 50) { }

	append(chunk: string): void {
		const parts = chunk.replace(ANSI_ESCAPE, '').split(/\r?\n/);
		this.lines[this.lines.length - 1] += parts[0];
		for (let i = 1; i < parts.length; i++) {
			this.lines.push(parts[i]);
		}
		// One extra slot for the line still being written.
		const excess = this.lines.length - (this.maxLines + 1);
		if (excess > 0) {
			this.lines.splice(0, excess);
		}
	}

	get text(): string {
		const lines = this.lines[this.lines.length - 1] === '' ? this.lines.slice(0, -1) : this.lines;
		return lines.slice(-this.maxLines).join('\n');
	}
}

/**
 * Message for a test that got no result. `terminated` holds the test
 * processes that ended during the run, with their last output.
 */
export function noResultMessage(terminated: readonly { label: string; tail: string }[]): string {
	const lines = ['No result was reported for this test. Its test process may have crashed.'];
	const withOutput = terminated.filter(t => t.tail.trim() !== '');
	if (withOutput.length === 0) {
		lines.push('See the "Julia Test Item Controller" output for details.');
	}
	for (const t of withOutput) {
		lines.push('', `Last output of ${t.label}:`, t.tail);
	}
	return lines.join('\n');
}
