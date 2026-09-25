/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the profile history behind the flame graph viewer (issue #14).
// Plain Node: run with `npm run test:unit`.

import * as assert from 'assert';

import { isProfile, Profile, ProfileStore } from '../../profiler/profile-store';

function profile(tag: string): Profile {
	return {
		type: 'Thread',
		data: { all: { func: tag, file: '', path: '', line: 0, count: 1, flags: 0, children: [] } },
	};
}

const tagOf = (store: ProfileStore) => store.current?.data.all.func;

suite('Profile store (issue #14)', () => {

	test('a new profile becomes current', () => {
		const store = new ProfileStore();
		assert.strictEqual(store.current, undefined);
		assert.strictEqual(store.currentIndex, -1);
		store.add(profile('a'));
		store.add(profile('b'));
		assert.strictEqual(tagOf(store), 'b');
		assert.strictEqual(store.currentIndex, 1);
	});

	test('next and previous stop at the ends', () => {
		const store = new ProfileStore();
		store.add(profile('a'));
		store.add(profile('b'));
		assert.strictEqual(store.move(1), false);
		assert.strictEqual(store.move(-1), true);
		assert.strictEqual(tagOf(store), 'a');
		assert.strictEqual(store.move(-1), false);
	});

	test('deleting the current profile keeps a neighbour current', () => {
		const store = new ProfileStore();
		['a', 'b', 'c'].forEach(t => store.add(profile(t)));
		store.move(-1); // b
		store.deleteCurrent();
		assert.strictEqual(tagOf(store), 'c'); // the one after moves into place
		store.deleteCurrent();
		assert.strictEqual(tagOf(store), 'a'); // last one removed: previous
		store.deleteCurrent();
		assert.strictEqual(store.current, undefined);
		assert.strictEqual(store.count, 0);
		store.deleteCurrent(); // no-op when empty
	});

	test('the oldest profile is dropped beyond capacity', () => {
		const store = new ProfileStore(2);
		['a', 'b', 'c'].forEach(t => store.add(profile(t)));
		assert.strictEqual(store.count, 2);
		store.move(-1);
		assert.strictEqual(tagOf(store), 'b');
	});

	test('clear removes everything', () => {
		const store = new ProfileStore();
		store.add(profile('a'));
		store.clear();
		assert.strictEqual(store.count, 0);
		assert.strictEqual(store.current, undefined);
	});

	test('only well-formed kernel payloads are accepted', () => {
		assert.ok(isProfile(profile('a')));
		assert.ok(!isProfile(undefined));
		assert.ok(!isProfile({ type: 'Thread' }));
		assert.ok(!isProfile({ type: 'Thread', data: { all: { count: 'x', children: [] } } }));
	});
});
