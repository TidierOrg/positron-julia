/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Profiles received from `@profview` this window, and which one is shown.
 *
 * No dependency on `vscode`, so it can be unit tested under plain Node.
 */

/** A frame of the profile tree, as serialized by `julia/Positron/src/profile.jl`. */
export interface ProfileFrame {
	func: string;
	file: string;
	path: string;
	line: number;
	count: number;
	flags: number;
	children: ProfileFrame[];
}

/** One `@profview` result: a frame tree per thread (plus `all`). */
export interface Profile {
	data: Record<string, ProfileFrame>;
	type: string;
}

/** Whether `value` looks like a profile sent by the kernel. */
export function isProfile(value: unknown): value is Profile {
	const p = value as Profile;
	return typeof p === 'object' && p !== null
		&& typeof p.type === 'string'
		&& typeof p.data === 'object' && p.data !== null
		&& Object.values(p.data).every(root => typeof root?.count === 'number' && Array.isArray(root.children));
}

export class ProfileStore {
	private readonly profiles: Profile[] = [];
	private index = -1;

	/** Keeps at most `capacity` profiles, dropping the oldest. */
	constructor(private readonly capacity = 20) { }

	get count(): number {
		return this.profiles.length;
	}

	/** 0-based index of the current profile, or -1 when there are none. */
	get currentIndex(): number {
		return this.index;
	}

	get current(): Profile | undefined {
		return this.profiles[this.index];
	}

	/** Adds a profile and makes it current. */
	add(profile: Profile): void {
		this.profiles.push(profile);
		if (this.profiles.length > this.capacity) {
			this.profiles.shift();
		}
		this.index = this.profiles.length - 1;
	}

	/** Moves to the next (`+1`) or previous (`-1`) profile, without wrapping. */
	move(step: 1 | -1): boolean {
		const next = this.index + step;
		if (next < 0 || next >= this.profiles.length) {
			return false;
		}
		this.index = next;
		return true;
	}

	/** Removes the current profile; the one before it (or after) becomes current. */
	deleteCurrent(): void {
		if (this.index < 0) {
			return;
		}
		this.profiles.splice(this.index, 1);
		this.index = Math.min(this.index, this.profiles.length - 1);
	}

	clear(): void {
		this.profiles.length = 0;
		this.index = -1;
	}
}
