/**
 * Math delimiter preprocessing — the \(...\)/\[...\] contract.
 *
 * The teacher writes inline math as `\(...\)` and display math as `\[...\]`;
 * a bare `$` is ALWAYS literal currency (system-prompt contract). remark-math
 * expects `$...$`/`$$...$$`, so this pure transform rewrites balanced
 * delimiters before the markdown hits Streamdown. Combined with
 * `singleDollarTextMath: false`, the dollar sign can never start math — the
 * currency hazard dies structurally.
 *
 * Rules:
 * - `\(...\)` → `$$...$$` (two-dollar inline: with
 *   `singleDollarTextMath: false` this is the only inline math form micromark
 *   still parses), `\[...\]` → `$$\n...\n$$` (block form: flow math).
 * - An escaped delimiter (`\\(` = literal backslash + paren) is left alone.
 * - Nothing inside fenced code blocks or inline code spans is touched.
 * - Unbalanced delimiters are left untouched: Streamdown streams chunks, and
 *   an incomplete `\[` completes on a later chunk (the whole text is
 *   re-transformed each render).
 *
 * Pure string → string. No markdown parsing — a single linear scan with a
 * code-state machine, cheap enough to run in the render path of a memo'd
 * component.
 */

const INLINE_OPEN = "\\(";
const INLINE_CLOSE = "\\)";
const DISPLAY_OPEN = "\\[";
const DISPLAY_CLOSE = "\\]";

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Is the backslash at `i` itself escaped (i.e. preceded by an odd number of
 * backslashes)? If so, the `\(`/`\[` starting there is a literal backslash
 * followed by a bracket — not a delimiter.
 */
function isEscaped(text: string, i: number): boolean {
	let count = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) count += 1;
	return count % 2 === 1;
}

/** Length of the backtick run starting at `i` (0 if `text[i]` is not a tick). */
function backtickRun(text: string, i: number): number {
	let count = 0;
	while (text[i + count] === "`") count += 1;
	return count;
}

/**
 * Try to find the closing delimiter for the opening one at `i` (2 chars,
 * already verified unescaped). The close scan stops at inline code spans and
 * fence starts (barriers — math never contains them), and returns -1 when the
 * delimiter is unbalanced (mid-stream chunk).
 */
function findClose(
	text: string,
	from: number,
	close: string,
): number {
	for (let j = from; j < text.length - 1; j++) {
		if (text[j] === "`") return -1; // inline code barrier
		if (
			text[j] === "\\" &&
			text[j + 1] === close[1] &&
			!isEscaped(text, j)
		) {
			return j;
		}
	}
	return -1;
}

/** True when `i` sits at the start of a line (position 0 or right after \n). */
function atLineStart(text: string, i: number): boolean {
	return i === 0 || text[i - 1] === "\n";
}

/**
 * Copy a fenced code block starting at `i` (line start, fence regex matched)
 * verbatim to the output. Returns the index after the closing fence line —
 * or the end of the text when the fence is unclosed (mid-stream: everything
 * after is literal code until the chunk completes).
 */
function copyFencedBlock(text: string, i: number, out: string[]): number {
	const open = FENCE_OPEN_RE.exec(text.slice(i));
	const marker = open?.[1] ?? "```";
	const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
	let j = i;
	// Copy lines until the matching closing fence.
	while (j < text.length) {
		const lineEnd = text.indexOf("\n", j);
		const next = lineEnd === -1 ? text.length : lineEnd + 1;
		const line = text.slice(j, lineEnd === -1 ? text.length : lineEnd);
		out.push(text.slice(j, next));
		if (j > i && closeRe.test(line)) return next; // closing fence line
		j = next;
	}
	return text.length;
}

/** Is the `\[` at `i` block-positioned (own line, only whitespace before)? */
function displayIsBlockPositioned(text: string, i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return true;
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

/** Is the `\[` at `i` indented (whitespace before it on the line)? */
function displayIsIndented(text: string, i: number): boolean {
	let sawWhitespace = false;
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === "\n") return sawWhitespace;
		if (ch !== " " && ch !== "\t") return false; // mid-paragraph
		sawWhitespace = true;
	}
	return sawWhitespace;
}

/** Does the closing delimiter end its line (only \n or EOF after it)? */
function closeEndsLine(text: string, afterClose: number): boolean {
	return afterClose >= text.length || text[afterClose] === "\n";
}

/**
 * Rewrite balanced `\(...\)` → `$$...$$` and `\[...\]` → `$$\n...\n$$`.
 * Everything else passes through byte-for-byte.
 */
export function transformMathDelimiters(markdown: string): string {
	const out: string[] = [];
	let i = 0;

	while (i < markdown.length) {
		const ch = markdown[i]!;

		// Fenced code blocks: copied verbatim (only detectable at line start).
		if (atLineStart(markdown, i) && FENCE_OPEN_RE.test(markdown.slice(i))) {
			i = copyFencedBlock(markdown, i, out);
			continue;
		}

		// Inline code spans: copied verbatim.
		if (ch === "`") {
			const run = backtickRun(markdown, i);
			let j = i + run;
			// Find the matching run (same length, per CommonMark).
			while (j < markdown.length) {
				const nextRun = backtickRun(markdown, j);
				if (nextRun === run) break;
				j += Math.max(nextRun, 1);
			}
			if (j < markdown.length) {
				out.push(markdown.slice(i, j + run));
				i = j + run;
			} else {
				// Unclosed run (mid-stream): literal, keep scanning after it.
				out.push(markdown.slice(i, i + run));
				i += run;
			}
			continue;
		}

		// Math delimiters.
		if (ch === "\\" && !isEscaped(markdown, i)) {
			const next = markdown[i + 1];
			if (next === "(" || next === "[") {
				const isDisplay = next === "[";
				const open = isDisplay ? DISPLAY_OPEN : INLINE_OPEN;
				const close = isDisplay ? DISPLAY_CLOSE : INLINE_CLOSE;
				const closeAt = findClose(markdown, i + open.length, close);
				if (closeAt !== -1) {
					const content = markdown.slice(i + open.length, closeAt).trim();
					if (content.length > 0) {
						if (isDisplay && displayIsIndented(markdown, i)) {
							// Indented display math (inside a list item, quote, …):
							// an indented $$ flow block half-parses inside list
							// continuations (empty math, eaten items), so degrade to
							// the inline form — renders inline, stays inside the item.
							// mathText cannot span line endings, so collapse them.
							out.push(`$$${content.replace(/\s*\n\s*/g, " ")}$$`);
						} else if (isDisplay) {
							// Flow math ($$ alone on its lines) renders as display
							// KaTeX. Mid-paragraph \[...\] (or trailing text after the
							// closer) would half-parse into literal dollars + KaTeX
							// errors — pad with blank lines to force a clean block.
							// Block-positioned math passes through in place.
							const afterClose = closeAt + close.length;
							const padBefore =
									displayIsBlockPositioned(markdown, i) ? "" : "\n\n";
							const padAfter =
									closeEndsLine(markdown, afterClose) ? "" : "\n\n";
							out.push(`${padBefore}$$\n${content}\n$$${padAfter}`);
						} else {
							// Two-dollar inline: the only inline math form left with
							// singleDollarTextMath: false (renders inline, not display).
							out.push(`$$${content}$$`);
						}
						i = closeAt + close.length;
						continue;
					}
				}
				// Unbalanced or empty: leave both characters untouched.
			}
		}

		out.push(ch);
		i += 1;
	}

	return out.join("");
}
