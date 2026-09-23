/**
 * Render tests for the presentation layer (W3): the \(...\)/\[...\] math
 * delimiter contract, single-newline line breaks, and mermaid rendering.
 *
 * Same idiom as render-cards.test.tsx: static HTML via react-dom/server, no
 * DOM. tsx note: tsx uses the CLASSIC JSX transform, so `React` must be a
 * resolvable global — the shim below provides it.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { MermaidError } from "../components/mermaid-error.tsx";
import { transformMathDelimiters } from "../src/core/math-delims.ts";

/** Render through MessageResponse in static mode (no streaming/remend artifacts). */
function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("math delimiter transform (pure unit)", () => {
	it("converts inline \\(...\\) to the two-dollar inline form", () => {
		assert.equal(
			transformMathDelimiters("a \\(x^2\\) b"),
			"a $$x^2$$ b",
		);
	});

	it("converts block-positioned \\[...\\] to flow math in place", () => {
		assert.equal(
			transformMathDelimiters("text\n\n\\[\n\\int x\n\\]\n\nmore"),
			"text\n\n$$\n\\int x\n$$\n\nmore",
		);
	});

	it("pads mid-paragraph \\[...\\) with blank lines (forces a clean block)", () => {
		assert.equal(
			transformMathDelimiters("mid \\[x^2\\] para"),
			"mid \n\n$$\nx^2\n$$\n\n para",
		);
	});

	it("degrades indented display math (list items) to the inline form", () => {
		// An indented $$ flow block half-parses inside list continuations;
		// inline keeps the math inside the item.
		assert.equal(
			transformMathDelimiters("- item\n  \\[\n  x^2\n  \\]\n- next"),
			"- item\n  $$x^2$$\n- next",
		);
	});

	it("leaves currency untouched", () => {
		const md = "It costs $5 and $10 more. $$big$$ sums too.";
		assert.equal(transformMathDelimiters(md), md);
	});

	it("leaves escaped delimiters untouched (\\\\( is a literal backslash)", () => {
		assert.equal(
			transformMathDelimiters("escaped \\\\( and \\\\[ stay"),
			"escaped \\\\( and \\\\[ stay",
		);
	});

	it("does not transform inside fenced code blocks", () => {
		const md = "```js\n\\(x\\) and \\[y\\]\n```";
		assert.equal(transformMathDelimiters(md), md);
	});

	it("does not transform inside inline code spans", () => {
		const md = "run `\\(x\\)` locally";
		assert.equal(transformMathDelimiters(md), md);
	});

	it("leaves unbalanced delimiters untouched (mid-stream chunks)", () => {
		assert.equal(
			transformMathDelimiters("partial \\[ mid-stream"),
			"partial \\[ mid-stream",
		);
		assert.equal(
			transformMathDelimiters("open \\( no close"),
			"open \\( no close",
		);
	});

	it("still converts a later balanced pair when an earlier one is unbalanced", () => {
		assert.equal(
			transformMathDelimiters("\\[ partial\n\nbut \\(ok\\)"),
			"\\[ partial\n\nbut $$ok$$",
		);
	});
});

describe("render — new math contract (streamdown + KaTeX)", () => {
	it("renders \\(...\\) as inline KaTeX", () => {
		const html = render("The map \\(f(x) = x^2\\) is smooth.");
		assert.ok(html.includes("katex"), `inline math should render, got: ${html.slice(0, 300)}`);
		assert.ok(!html.includes("katex-display"), "parens math is inline, never display");
	});

	it("renders \\[x^2\\] as display math", () => {
		const html = render("Intro:\n\n\\[\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n\\]\n\nOutro.");
		assert.ok(html.includes("katex-display"), "bracket math on its own lines is display math");
	});

	it("renders mid-paragraph \\[...\\] as display math without leaking dollars", () => {
		const html = render("before \\[x^2\\] after");
		assert.ok(html.includes("katex-display"), "mid-paragraph display math is hoisted to a block");
		assert.ok(!html.includes("$$"), "no literal $$ leaks");
		assert.ok(!html.includes("katex-error"), "no KaTeX parse errors");
	});

	it("renders display math inside list items without eating the list", () => {
		const html = render("- item one\n  \\[x^2\\]\n- item two");
		assert.ok(html.includes("katex"), "indented display math degrades to inline KaTeX");
		assert.ok(html.includes("item two"), "the following list item survives");
		const items = html.match(/data-streamdown="list-item"/g) ?? [];
		assert.equal(items.length, 2, "both list items render");
	});

	it("renders bare $ as literal currency — the hazard dies structurally", () => {
		const html = render("It costs $5 and $10 more.");
		assert.ok(!html.includes("katex"), "currency must never parse as math");
		assert.match(html, /\$5 and \$10/);
	});

	it("renders old-contract $...$ math as literal text (singleDollarTextMath: false)", () => {
		const html = render("The map $f(x) = x^2$ is smooth.");
		assert.ok(!html.includes("katex"), "$ can never start math");
		assert.match(html, /\$f\(x\) = x\^2\$/, "the old form renders verbatim");
	});

	it("keeps \\(...\\) inside a code fence literal", () => {
		const html = render("```\n\\(x^2\\) stays literal\n```");
		assert.ok(!html.includes("katex"), "code fences are never math");
		assert.ok(html.includes("code-block"), "it renders as a code block");
	});

	it("leaves an unbalanced \\[ mid-stream untouched", () => {
		const html = render("partial \\[ mid-stream");
		assert.ok(!html.includes("katex") && !html.includes("$$"), "no math, no dollars");
	});

	it("renders math inside headings and keeps the heading", () => {
		const html = render("## The map \\(f(x)\\)");
		assert.ok(html.includes("<h2"), "heading survives");
		assert.ok(html.includes("katex"), "heading math renders");
	});
});

describe("render — line breaks (remark-breaks)", () => {
	it("renders a single newline as a visible line break", () => {
		const html = render("line one\nline two");
		assert.match(html, /<br\s*\/?>/, "single \\n becomes a hard break");
	});

	it("keeps single newlines inside code blocks as code lines (no <br>)", () => {
		const html = render("```js\nline one\nline two\n```");
		assert.ok(html.includes("code-block"), "code block renders");
		assert.ok(!html.includes("<br"), "code blocks have no injected breaks");
	});

	it("keeps lists as lists (no break-collapse)", () => {
		const html = render("- alpha\n- beta");
		const items = html.match(/data-streamdown="list-item"/g) ?? [];
		assert.equal(items.length, 2, "two list items");
		assert.ok(!html.includes("<br"), "list lines are not breaks");
	});

	it("keeps GFM tables intact (remark-breaks did not replace the defaults)", () => {
		const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
		assert.ok(html.includes("<table"), "GFM table renders");
	});
});

describe("render — mermaid", () => {
	it("renders a mermaid fence as a diagram container, not a raw code block", () => {
		// SSR renders the lazy chunk's Suspense skeleton (the diagram itself
		// mounts client-side after hydration) — so assert on what must NOT
		// happen: the mermaid language must not take the code-block path, and
		// the chart source must not leak as visible code.
		const html = render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(
			!html.includes('data-streamdown="code-block"'),
			"mermaid fences must not render as code blocks",
		);
		assert.ok(!html.includes("graph TD"), "chart source is not leaked as text");
	});

	it("still renders ordinary code fences as code blocks (contrast)", () => {
		const html = render("```js\nconst x = 1;\n```");
		assert.ok(html.includes('data-streamdown="code-block"'), "js fences keep the code-block path");
	});

	it("renders the error fallback for invalid mermaid: error + source + retry", () => {
		// The fallback component mounts client-side when mermaid fails to
		// parse; render it directly to pin its contract.
		const html = renderToStaticMarkup(
			<MermaidError
				chart={"not a diagram @@@\nA --> B"}
				error="Parse error on line 1: unexpected text"
				retry={() => {}}
			/>,
		);
		assert.match(html, /Diagram failed to render/);
		assert.match(html, /Parse error on line 1/);
		assert.match(html, /Show diagram source/);
		assert.match(html, /not a diagram/);
		assert.match(html, />Retry</);
	});
});


describe("render — bold is the real <strong> (the dead Bold-color fix)", () => {
	// Streamdown's default `strong` renders <span class="font-semibold"
	// data-streamdown="strong"> — and the app's ink token rule
	// (.lh-prose :where(strong, b), globals.css) matches strong/b
	// ELEMENTS, so bold never took the --lh-ink-strong color (neither the
	// factory #ee928c nor a settings boldColor). The mdComponents override
	// renders the semantic element.
	it("bold renders a real <strong> element inside .lh-prose", () => {
		const html = render("plain **bold** plain");
		assert.ok(
			html.includes('<strong data-streamdown="strong">bold</strong>'),
			"bold renders as a semantic strong element",
		);
		assert.ok(html.includes("lh-prose"), "the markdown surface carries .lh-prose (the token rule's anchor)");
	});

	it("no span-for-bold regression: the font-semibold span is gone", () => {
		const html = render("plain **bold** plain");
		assert.ok(!html.includes('class="font-semibold"'), "streamdown's span/600 default must not render bold");
	});

	it("italic stays native <em> (the case that always worked)", () => {
		const html = render("plain *emph* plain");
		assert.ok(html.includes("<em>"), "italic renders a native em element");
	});
});
