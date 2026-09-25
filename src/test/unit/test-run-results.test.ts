/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for giving every test in a run a result (issue #19).
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';

import { noResultMessage, OutputTail, settlePendingItems } from '../../testing/test-run-results';

suite('Test run results (issue #19)', () => {

	test('every pending test is settled once and the pending set is cleared', () => {
		const run = {
			testItems: new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]),
			pendingItems: new Set(['a', 'c']),
		};
		const settled: string[] = [];
		assert.strictEqual(settlePendingItems(run, item => settled.push(item)), 2);
		assert.deepStrictEqual(settled, ['A', 'C']);
		assert.strictEqual(run.pendingItems.size, 0);
	});

	test('nothing pending: nothing settled', () => {
		const run = { testItems: new Map([['a', 'A']]), pendingItems: new Set<string>() };
		let calls = 0;
		assert.strictEqual(settlePendingItems(run, () => calls++), 0);
		assert.strictEqual(calls, 0);
	});

	test('pending ids without a test item are dropped', () => {
		const run = { testItems: new Map<string, string>(), pendingItems: new Set(['gone']) };
		assert.strictEqual(settlePendingItems(run, () => assert.fail('no item to settle')), 0);
		assert.strictEqual(run.pendingItems.size, 0);
	});

	test('output tail keeps the last lines across chunk boundaries, without colors', () => {
		const tail = new OutputTail(3);
		tail.append('one\ntw');
		tail.append('o\n\x1b[31mthree\x1b[0m\nfour\n');
		assert.strictEqual(tail.text, 'two\nthree\nfour');
		tail.append('fi');
		assert.strictEqual(tail.text, 'three\nfour\nfi');
	});

	test('output tail handles Windows line endings', () => {
		const tail = new OutputTail(5);
		tail.append('a\r\nb\r\n');
		assert.strictEqual(tail.text, 'a\nb');
	});

	test('message includes the output of processes that ended during the run', () => {
		const msg = noResultMessage([
			{ label: 'test process for MyPkg', tail: 'signal (6): Abort trap: 6' },
			{ label: 'test process for Quiet', tail: '  ' },
		]);
		assert.ok(msg.startsWith('No result was reported for this test.'));
		assert.ok(msg.includes('Last output of test process for MyPkg:\nsignal (6): Abort trap: 6'));
		assert.ok(!msg.includes('Quiet'));
	});

	test('message without process output points to the controller output', () => {
		assert.ok(noResultMessage([]).includes('"Julia Test Item Controller" output'));
	});
});
