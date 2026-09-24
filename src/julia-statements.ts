/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Julia statement boundaries for "run the statement at the cursor"
 * (Ctrl+Enter / Cmd+Enter).
 *
 * The document is scanned from the top with a small lexer so that the
 * statement *containing* the cursor is found wherever the cursor sits: on the
 * first line, on a continuation line of a multi-line call (issue #39), inside a
 * block body, or on a block's closing `end`. Like julia-vscode's "Execute Code
 * Block", a whole top-level statement is returned; the bodies of `module`
 * blocks are the one exception and are split into their own statements.
 *
 * The lexer understands strings (including triple-quoted, prefixed and
 * interpolated ones), char literals vs. the adjoint `'`, `#` and nested `#= =#`
 * comments, brackets, block keywords, `begin`/`end` used as indices inside
 * `[...]`, comprehensions/generators, docstrings, and trailing binary operators
 * that continue a statement on the next line.
 *
 * This module deliberately has no dependency on `vscode` or `positron` so it
 * can be unit tested under plain Node.
 */

/** An inclusive, 0-based range of lines. */
export interface LineRange {
	startLine: number;
	endLine: number;
}

/** A top-level statement (or a statement directly inside a module body). */
export interface JuliaStatement extends LineRange {
	/** True when the statement is still open at the end of the document. */
	unterminated: boolean;
}

/** A `module`/`baremodule` block, whose body holds its own statements. */
export interface JuliaModuleBlock extends LineRange {
	/** Line holding the `module` keyword (after any docstring). */
	headerLine: number;
	/** True when the module has no closing `end`. */
	unterminated: boolean;
}

/** The statements of a document. */
export interface JuliaSegmentation {
	/** Statements in document order, including those inside module bodies. */
	statements: JuliaStatement[];
	/** Module blocks, in document order of their first line. */
	modules: JuliaModuleBlock[];
}

// ── Character classes ───────────────────────────────────────────────────

const NON_ASCII_IDENT_START = /[\p{L}\p{Nl}\p{So}∂∇∞]/u;
const NON_ASCII_IDENT_CHAR = /[\p{L}\p{N}\p{M}\p{Pc}\p{So}′″‴⁗∂∇∞]/u;
const NON_ASCII_OPERATOR = /[\p{Sm}]/u;
const ASCII_OPERATORS = '+-*/\\^%&|<>=!~?:.';

function isAsciiLetter(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isDigit(c: string): boolean {
	return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
	if (c === '') {
		return false;
	}
	if (c < '\u0080') {
		return isAsciiLetter(c) || c === '_';
	}
	return !isOperatorChar(c) && NON_ASCII_IDENT_START.test(c);
}

function isIdentChar(c: string): boolean {
	if (c === '') {
		return false;
	}
	if (c < '\u0080') {
		return isAsciiLetter(c) || isDigit(c) || c === '_' || c === '!';
	}
	return !isOperatorChar(c) && NON_ASCII_IDENT_CHAR.test(c);
}

function isOperatorChar(c: string): boolean {
	if (c === '') {
		return false;
	}
	if (c < '\u0080') {
		return ASCII_OPERATORS.includes(c);
	}
	// ∂, ∇ and ∞ are math symbols that Julia accepts in identifiers.
	return c !== '∂' && c !== '∇' && c !== '∞' && NON_ASCII_OPERATOR.test(c);
}

function isWhitespace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ';
}

/** The (possibly astral) character starting at index `i`. */
function charAt(text: string, i: number): string {
	const code = text.charCodeAt(i);
	if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
		return text.substring(i, i + 2);
	}
	return text[i];
}

/** The character ending just before index `i`, or '' at the start of the line. */
function charBefore(text: string, i: number): string {
	if (i <= 0) {
		return '';
	}
	const code = text.charCodeAt(i - 1);
	if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
		return text.substring(i - 2, i);
	}
	return text[i - 1];
}

/** Whether a `'` right after `prev` is the postfix adjoint operator. */
function isAdjointAfter(prev: string): boolean {
	return prev !== '' && (isIdentChar(prev) || prev === ')' || prev === ']' ||
		prev === '}' || prev === "'" || prev === '.');
}

/** Whether `prev` can end an operand (so a following `:` is a range or ternary). */
function endsOperand(prev: string): boolean {
	return prev !== '' && (isIdentChar(prev) || prev === ')' || prev === ']' ||
		prev === '}' || prev === "'" || prev === '"' || prev === '`');
}

/**
 * If a char literal starts at `i` (a `'`), returns the index just past its
 * closing quote; otherwise -1.
 */
function charLiteralEnd(text: string, i: number): number {
	const j = i + 1;
	if (j >= text.length) {
		return -1;
	}
	if (text[j] === '\\') {
		// Escapes: '\n', '\'', '\\', '\x41', '∀', '\U1F600', '\0177'
		const limit = Math.min(text.length, j + 12);
		for (let k = j + 2; k < limit; k++) {
			if (text[k] === "'") {
				return k + 1;
			}
		}
		return -1;
	}
	const next = j + charAt(text, j).length;
	return text[next] === "'" ? next + 1 : -1;
}

/** Keywords that open a block closed by `end`. */
const BLOCK_KEYWORDS = new Set([
	'function', 'macro', 'struct', 'while', 'let', 'try', 'quote', 'do',
]);

/** Statements whose trailing operators are names (`import Base: +, *`). */
const NAME_LIST_KEYWORDS = new Set(['import', 'using', 'export', 'public']);

// ── Lexer state ─────────────────────────────────────────────────────────

type Frame =
	| { kind: 'code' }
	| { kind: 'interp'; depth: number }
	| { kind: 'string'; delim: string; raw: boolean }
	| { kind: 'comment'; depth: number };

type Opener =
	| { kind: 'bracket' }
	| { kind: 'block' }
	| { kind: 'module'; startLine: number; headerLine: number };

type TokenKind = 'word' | 'op' | 'comma' | 'semicolon' | 'string' | 'number' | 'bracket' | 'other';

interface LastToken {
	kind: TokenKind;
	text: string;
	/** Character just before the token on its line ('' at the line start). */
	before: string;
}

interface OpenStatement {
	startLine: number;
	lastLine: number;
	tokens: number;
	firstWord: string | undefined;
	firstIsPlainString: boolean;
	last: LastToken | undefined;
}

class Segmenter {
	private readonly frames: Frame[] = [{ kind: 'code' }];
	private readonly openers: Opener[] = [];
	private nonModuleOpeners = 0;

	private current: OpenStatement | undefined;
	private pendingDocstring: JuliaStatement | undefined;
	/** Rest of the current line belongs to a module header/footer. */
	private skipRestOfLine = false;
	/** Previous word token on the current line, for `abstract type`. */
	private previousWord: string | undefined;

	private readonly statements: JuliaStatement[] = [];
	private readonly modules: JuliaModuleBlock[] = [];

	run(lines: readonly string[]): JuliaSegmentation {
		for (let line = 0; line < lines.length; line++) {
			this.scanLine(lines[line], line);
		}
		this.finish(lines.length - 1);
		this.modules.sort((a, b) => a.startLine - b.startLine);
		return { statements: this.statements, modules: this.modules };
	}

	// ── Line scanning ───────────────────────────────────────────────────

	private scanLine(text: string, line: number): void {
		this.skipRestOfLine = false;
		this.previousWord = undefined;

		// A line that starts inside a string or block comment opened by the
		// current statement belongs to that statement.
		if (this.frames.length > 1 && this.current) {
			this.current.lastLine = line;
		}

		let i = 0;
		while (i < text.length) {
			const frame = this.frames[this.frames.length - 1];
			switch (frame.kind) {
				case 'comment':
					i = this.scanComment(text, i, frame);
					break;
				case 'string':
					i = this.scanString(text, i, frame);
					break;
				default:
					i = this.scanCode(text, i, frame, line);
					break;
			}
		}

		this.endOfLine();
	}

	private scanComment(text: string, i: number, frame: { depth: number }): number {
		while (i < text.length) {
			if (text.startsWith('=#', i)) {
				i += 2;
				frame.depth--;
				if (frame.depth === 0) {
					this.frames.pop();
					return i;
				}
			} else if (text.startsWith('#=', i)) {
				i += 2;
				frame.depth++;
			} else {
				i++;
			}
		}
		return i;
	}

	private scanString(
		text: string,
		i: number,
		frame: { delim: string; raw: boolean },
	): number {
		while (i < text.length) {
			const c = text[i];
			if (c === '\\') {
				i += 2;
				continue;
			}
			if (text.startsWith(frame.delim, i)) {
				this.frames.pop();
				return i + frame.delim.length;
			}
			if (!frame.raw && c === '$' && text[i + 1] === '(') {
				this.frames.push({ kind: 'interp', depth: 1 });
				return i + 2;
			}
			i++;
		}
		return i;
	}

	private scanCode(text: string, i: number, frame: Frame, line: number): number {
		const c = text[i];
		if (isWhitespace(c)) {
			return i + 1;
		}

		// Comments are whitespace to the parser.
		if (c === '#') {
			if (text[i + 1] === '=') {
				this.frames.push({ kind: 'comment', depth: 1 });
				return i + 2;
			}
			return text.length;
		}

		const topLevel = frame.kind === 'code';
		const before = charBefore(text, i);

		// Strings and commands. A string glued to an identifier is a
		// non-standard string literal (r"...", raw"...") without interpolation.
		if (c === '"' || c === '`') {
			const triple = text.startsWith(c.repeat(3), i);
			const raw = before !== '' && isIdentChar(before);
			if (topLevel) {
				this.token(line, 'string', c, before, raw);
			}
			this.frames.push({ kind: 'string', delim: triple ? c.repeat(3) : c, raw });
			return i + (triple ? 3 : 1);
		}

		if (c === "'") {
			if (!isAdjointAfter(before)) {
				const end = charLiteralEnd(text, i);
				if (end > 0) {
					if (topLevel) {
						this.token(line, 'other', "'", before);
					}
					return end;
				}
			}
			if (topLevel) {
				this.token(line, 'other', "'", before);
			}
			return i + 1;
		}

		// Inside `$( ... )` only the parentheses matter: they tell us where the
		// interpolation ends. Strings and comments were handled above.
		if (frame.kind === 'interp') {
			if (c === '(') {
				frame.depth++;
			} else if (c === ')') {
				frame.depth--;
				if (frame.depth === 0) {
					this.frames.pop();
				}
			}
			return i + 1;
		}

		if (c === '(' || c === '[' || c === '{') {
			this.token(line, 'bracket', c, before);
			this.pushOpener({ kind: 'bracket' });
			return i + 1;
		}
		if (c === ')' || c === ']' || c === '}') {
			this.token(line, 'bracket', c, before);
			this.closeBracket();
			return i + 1;
		}

		if (isDigit(c)) {
			const end = this.scanNumber(text, i);
			this.token(line, 'number', text.substring(i, end), before);
			return end;
		}

		if (c === '@') {
			let end = i + 1;
			while (end < text.length && isIdentChar(charAt(text, end))) {
				end += charAt(text, end).length;
			}
			this.token(line, 'word', text.substring(i, end), before);
			return Math.max(end, i + 1);
		}

		const ch = charAt(text, i);
		if (isIdentStart(ch)) {
			let end = i + ch.length;
			while (end < text.length && isIdentChar(charAt(text, end))) {
				end += charAt(text, end).length;
			}
			const word = text.substring(i, end);
			this.word(text, i, word, line, before);
			return end;
		}

		if (c === ',') {
			this.token(line, 'comma', c, before);
			return i + 1;
		}
		if (c === ';') {
			this.token(line, 'semicolon', c, before);
			return i + 1;
		}

		if (isOperatorChar(ch)) {
			let end = i + ch.length;
			while (end < text.length && isOperatorChar(charAt(text, end))) {
				end += charAt(text, end).length;
			}
			this.token(line, 'op', text.substring(i, end), before);
			return end;
		}

		this.token(line, 'other', ch, before);
		return i + ch.length;
	}

	private scanNumber(text: string, i: number): number {
		let end = i;
		while (end < text.length) {
			const c = text[end];
			if (isAsciiLetter(c) || isDigit(c) || c === '_') {
				end++;
			} else if (c === '.' && text[end + 1] !== '.' && !isOperatorChar(text[end + 1] ?? '')) {
				// `1.5` and `1.`, but not `1..2` or `1.+x`.
				end++;
			} else if ((c === '+' || c === '-') && /[eEfpP]/.test(text[end - 1]) &&
				!/^0[xX]/.test(text.substring(i, end)) && isDigit(text[end + 1] ?? '')) {
				end++;
			} else {
				break;
			}
		}
		return end;
	}

	// ── Tokens ──────────────────────────────────────────────────────────

	private word(text: string, i: number, word: string, line: number, before: string): void {
		const previousWord = this.previousWord;
		if (this.isKeywordPosition(text, i, before)) {
			switch (word) {
				case 'end': {
					const top = this.openers[this.openers.length - 1];
					if (top?.kind === 'module') {
						this.closeModule(line, top);
						return;
					}
					// Closes a block, or is `x[end]` / an unmatched `end`.
					this.token(line, 'word', word, before);
					if (top?.kind === 'block') {
						this.popOpener();
					}
					return;
				}
				case 'begin':
					// `x[begin]`: directly inside brackets, `begin` is an index.
					if (!this.topIsBracket()) {
						this.token(line, 'word', word, before);
						this.pushOpener({ kind: 'block' });
						return;
					}
					break;
				case 'for':
				case 'if':
					// Directly inside brackets these are comprehension or
					// generator clauses, not blocks.
					if (!this.topIsBracket()) {
						this.token(line, 'word', word, before);
						this.pushOpener({ kind: 'block' });
						return;
					}
					break;
				case 'type':
					if (previousWord === 'abstract' || previousWord === 'primitive') {
						this.token(line, 'word', word, before);
						this.pushOpener({ kind: 'block' });
						return;
					}
					break;
				case 'module':
				case 'baremodule':
					this.openModule(line, word, before);
					return;
				default:
					if (BLOCK_KEYWORDS.has(word)) {
						this.token(line, 'word', word, before);
						this.pushOpener({ kind: 'block' });
						return;
					}
					break;
			}
		}
		this.token(line, 'word', word, before);
	}

	/**
	 * Whether a word at `i` can be a keyword: not a field (`x.end`) and not a
	 * quoted symbol (`:end`, `Expr(:if, ...)`).
	 */
	private isKeywordPosition(text: string, i: number, before: string): boolean {
		if (before === '.' && charBefore(text, i - 1) !== '.') {
			return false;
		}
		if (before === ':' && !endsOperand(charBefore(text, i - 1)) && charBefore(text, i - 1) !== ':') {
			return false;
		}
		return true;
	}

	/** Records a top-level token, starting a statement if none is open. */
	private token(line: number, kind: TokenKind, text: string, before: string, rawString = false): void {
		this.previousWord = kind === 'word' ? text : undefined;
		if (this.skipRestOfLine) {
			return;
		}
		let current = this.current;
		if (!current) {
			current = this.startStatement(line);
		}
		if (current.tokens === 0) {
			current.firstWord = kind === 'word' ? text : undefined;
			current.firstIsPlainString = kind === 'string' && text === '"' && !rawString;
		}
		current.tokens++;
		current.lastLine = line;
		current.last = { kind, text, before };
	}

	private startStatement(line: number): OpenStatement {
		let startLine = line;
		const docstring = this.pendingDocstring;
		if (docstring) {
			this.pendingDocstring = undefined;
			if (docstring.endLine === line - 1) {
				// A docstring directly above a statement documents it.
				startLine = docstring.startLine;
			} else {
				this.statements.push(docstring);
			}
		}
		this.current = {
			startLine,
			lastLine: line,
			tokens: 0,
			firstWord: undefined,
			firstIsPlainString: false,
			last: undefined,
		};
		return this.current;
	}

	// ── Openers ─────────────────────────────────────────────────────────

	private pushOpener(opener: Opener): void {
		this.openers.push(opener);
		if (opener.kind !== 'module') {
			this.nonModuleOpeners++;
		}
	}

	private popOpener(): Opener | undefined {
		const opener = this.openers.pop();
		if (opener && opener.kind !== 'module') {
			this.nonModuleOpeners--;
		}
		return opener;
	}

	private topIsBracket(): boolean {
		return this.openers[this.openers.length - 1]?.kind === 'bracket';
	}

	/** Closes the innermost bracket, abandoning blocks left open inside it. */
	private closeBracket(): void {
		for (let k = this.openers.length - 1; k >= 0; k--) {
			const kind = this.openers[k].kind;
			if (kind === 'module') {
				return; // stray closer; never cross a module boundary
			}
			if (kind === 'bracket') {
				while (this.openers.length > k) {
					this.popOpener();
				}
				return;
			}
		}
	}

	/** Handles the `end` of a module block. */
	private closeModule(line: number, module: { startLine: number; headerLine: number }): void {
		this.popOpener();
		// A statement left open in the module body (e.g. by a trailing
		// operator) ends where its code ends.
		if (this.current) {
			this.finishStatement(this.current.lastLine, false);
		}
		this.flushDocstring();
		this.modules.push({
			startLine: module.startLine,
			headerLine: module.headerLine,
			endLine: line,
			unterminated: false,
		});
		this.skipRestOfLine = true;
	}

	private openModule(line: number, word: string, before: string): void {
		if (this.nonModuleOpeners > 0 || (this.current && this.current.tokens > 0) || this.skipRestOfLine) {
			// Not a statement of its own (e.g. `@eval module M ... end`): treat
			// it as an ordinary block.
			this.token(line, 'word', word, before);
			this.pushOpener({ kind: 'block' });
			return;
		}
		const statement = this.current ?? this.startStatement(line);
		this.current = undefined;
		this.pushOpener({ kind: 'module', startLine: statement.startLine, headerLine: line });
		// The module name and anything else on the header line belong to the
		// module, not to a statement in its body.
		this.skipRestOfLine = true;
	}

	// ── Statement boundaries ────────────────────────────────────────────

	private endOfLine(): void {
		const current = this.current;
		if (!current) {
			return;
		}
		if (this.frames.length > 1 || this.nonModuleOpeners > 0 || this.continues(current)) {
			return;
		}
		this.finishStatement(current.lastLine, false);
	}

	/** Whether the statement's last token carries it onto the next line. */
	private continues(statement: OpenStatement): boolean {
		const last = statement.last;
		if (!last) {
			return false;
		}
		if (last.kind === 'comma') {
			return true;
		}
		if (last.kind !== 'op') {
			return false;
		}
		const op = last.text;
		// Splat `x...` and field access dots.
		if (/^\.+$/.test(op)) {
			return false;
		}
		// Operators are names in `import Base: +, *`; only a trailing `:`
		// (`import Base:`) continues such a statement.
		if (statement.firstWord && NAME_LIST_KEYWORDS.has(statement.firstWord)) {
			return op === ':';
		}
		// Quoted operator symbols: `op = :+`, `Base.:*`.
		if (op.length > 1 && op.startsWith(':') && !endsOperand(last.before)) {
			return false;
		}
		if (op.startsWith('.:')) {
			return false;
		}
		return true;
	}

	private finishStatement(endLine: number, unterminated: boolean): void {
		const current = this.current;
		if (!current) {
			return;
		}
		this.current = undefined;
		const statement: JuliaStatement = { startLine: current.startLine, endLine, unterminated };
		if (!unterminated && current.tokens === 1 && current.firstIsPlainString) {
			// Possibly a docstring for the statement on the next line.
			this.flushDocstring();
			this.pendingDocstring = statement;
			return;
		}
		this.statements.push(statement);
	}

	private flushDocstring(): void {
		if (this.pendingDocstring) {
			this.statements.push(this.pendingDocstring);
			this.pendingDocstring = undefined;
		}
	}

	private finish(lastLine: number): void {
		const current = this.current;
		if (current) {
			// Still open at the end of the document: unclosed bracket, block or
			// string, or a trailing operator.
			this.finishStatement(current.lastLine, true);
		}
		this.flushDocstring();
		for (const opener of this.openers) {
			if (opener.kind === 'module') {
				this.modules.push({
					startLine: opener.startLine,
					headerLine: opener.headerLine,
					endLine: Math.max(lastLine, opener.headerLine),
					unterminated: true,
				});
			}
		}
	}
}

/** Splits Julia source lines into statements. */
export function segmentJuliaStatements(lines: readonly string[]): JuliaSegmentation {
	return new Segmenter().run(lines);
}

/**
 * Finds the statement to run for a cursor on `line`: the statement containing
 * the line, or else the next statement below it. Returns undefined when there
 * is no code at or below the cursor.
 *
 * @param segmentation Precomputed segmentation of `lines`, if available.
 */
export function findJuliaStatementAt(
	lines: readonly string[],
	line: number,
	segmentation: JuliaSegmentation = segmentJuliaStatements(lines),
): LineRange | undefined {
	return findStatement(lines, line, segmentation, 0);
}

/** How many unclosed openers above the cursor to recover from. */
const MAX_RECOVERY_DEPTH = 8;

function findStatement(
	lines: readonly string[],
	line: number,
	segmentation: JuliaSegmentation,
	depth: number,
): LineRange | undefined {
	const { statements, modules } = segmentation;

	const containing = statements.find(s => s.startLine <= line && line <= s.endLine);
	if (containing) {
		if (containing.unterminated && line > containing.startLine) {
			// Something above the cursor never closes (unfinished code or a
			// syntax error), so it runs into the cursor's statement. Treat the
			// line that opened it as broken and read the code after it again.
			if (depth < MAX_RECOVERY_DEPTH) {
				const offset = containing.startLine + 1;
				const tail = lines.slice(offset);
				const found = findStatement(tail, line - offset, segmentJuliaStatements(tail), depth + 1);
				return found && { startLine: found.startLine + offset, endLine: found.endLine + offset };
			}
			return findFromLine(lines, line);
		}
		return toRange(containing);
	}

	// The `module` line (with its docstring) or the closing `end` of a module
	// runs the whole module.
	const moduleBlock = modules.find(m =>
		(m.startLine <= line && line <= m.headerLine) || line === m.endLine);
	if (moduleBlock) {
		return toRange(moduleBlock);
	}

	// Blank or comment line: run the next statement below the cursor. Inside a
	// module body, after its last statement, that is the module itself.
	let next: LineRange | undefined;
	let nextLine = Infinity;
	for (const statement of statements) {
		if (statement.startLine > line && statement.startLine < nextLine) {
			next = statement;
			nextLine = statement.startLine;
		}
	}
	for (const m of modules) {
		if (m.startLine > line && m.startLine < nextLine) {
			next = m;
			nextLine = m.startLine;
		}
		if (!m.unterminated && m.startLine < line && line < m.endLine && m.endLine < nextLine) {
			next = m;
			nextLine = m.endLine;
		}
	}
	return next ? toRange(next) : undefined;
}

/** Statement lookup that assumes a statement starts at or after `line`. */
function findFromLine(lines: readonly string[], line: number): LineRange | undefined {
	const tail = lines.slice(line);
	const segmentation = segmentJuliaStatements(tail);
	const first = segmentation.statements[0];
	const firstModule = segmentation.modules[0];
	let range: LineRange | undefined = first;
	if (firstModule && (!first || firstModule.startLine < first.startLine)) {
		range = firstModule;
	}
	return range
		? { startLine: range.startLine + line, endLine: range.endLine + line }
		: undefined;
}

function toRange(range: LineRange): LineRange {
	return { startLine: range.startLine, endLine: range.endLine };
}
