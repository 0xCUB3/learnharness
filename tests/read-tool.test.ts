/**
 * The read tool (sources v0) — a Node port of pi's read semantics:
 * truncation with continuation offsets, image mime detection, error paths.
 * Plus the lh-tool.ts image-result escape hatch it exercises.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readTool } from "../src/agent/tools/read.ts";
import { toPiTool } from "../src/agent/lh-tool.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-test-"));

function write(name: string, content: string): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, content, "utf-8");
	return file;
}

/** The 2-line/8-byte local config, applied the same way as the real caps. */
const run = (args: { path: string; offset?: number; limit?: number }) =>
	(readTool.execute as (i: unknown, c: { toolCallId: string }) => Promise<unknown>)!(args, {
		toolCallId: "test",
	});

describe("read tool — text semantics", () => {
	it("reads a small file verbatim", async () => {
		const file = write("small.txt", "hello\nworld");
		assert.equal(await run({ path: file }), "hello\nworld");
	});

	it("resolves relative paths against the learner's home (sources v1 anchoring)", async () => {
		// sources v1: the harness has no meaningful cwd — "find my notes" must
		// work from a bare relative path, so the home directory is the anchor
		// (fs-shared resolveSourcePath). Scratch file in home, cleaned up.
		const rel = `lh-read-rel-test-${process.pid}.txt`;
		const homeFile = path.join(os.homedir(), rel);
		fs.writeFileSync(homeFile, "rel", "utf-8");
		try {
			assert.equal(await run({ path: rel }), "rel");
		} finally {
			fs.unlinkSync(homeFile);
		}
	});

	it("honors offset (1-indexed) and limit", async () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const file = write("thirty.txt", body);
		const out = (await run({ path: file, offset: 10, limit: 3 })) as string;
		// pi parity: the explicit limit stopping short gets a remaining notice
		assert.match(out, /^line 10\nline 11\nline 12\n\n\[18 more lines in file\. Use offset=13 to continue\.\]$/);
	});

	it("offset beyond EOF is an error the model sees", async () => {
		const file = write("tiny.txt", "one");
		await assert.rejects(() => run({ path: file, offset: 99 }), /beyond end of file/);
	});

	it("a missing file throws (pi's error-result semantics)", async () => {
		await assert.rejects(() => run({ path: path.join(tmp, "nope.txt") }), /ENOENT/);
	});

	it("truncates at 2000 lines with a use-offset continuation notice", async () => {
		const body = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("big.txt", body);
		const out = (await run({ path: file })) as string;
		assert.match(out, /Showing lines 1-2000 of 3000 \(2000 line limit\)/);
		assert.match(out, /Use offset=2001 to continue/);
		assert.ok(!out.includes("l2001\n"), "line 2001 must not ride along");
	});

	it("truncates at 50KB with the same continuation notice", async () => {
		// 200 lines of ~400B = ~80KB total, under the line cap — byte cap fires
		const line = "x".repeat(400);
		const body = Array.from({ length: 200 }, () => line).join("\n");
		const file = write("wide.txt", body);
		const out = (await run({ path: file })) as string;
		assert.match(out, /50\.0KB limit\)\. Use offset=\d+ to continue\./);
		// and the truncation actually cut content
		assert.ok(out.length < 52_000, "the 50KB ceiling must cut the 80KB body");
	});

	it("an explicit limit that stops short gets a remaining-lines notice", async () => {
		const body = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("ten.txt", body);
		const out = (await run({ path: file, limit: 4 })) as string;
		assert.match(out, /\[6 more lines in file\. Use offset=5 to continue\.\]/);
	});
});

describe("read tool — image semantics", () => {
	it("returns the LhToolImageResult escape-hatch shape for image files", async () => {
		const file = path.join(tmp, "dot.png");
		// minimal valid PNG header bytes are enough — detection is by extension
		fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const out = (await run({ path: file })) as { text: string; images?: { data: string; mimeType: string }[] };
		assert.match(out.text, /Read image file \[image\/png\]/);
		assert.equal(out.images?.length, 1);
		assert.equal(out.images![0]!.mimeType, "image/png");
		assert.match(out.images![0]!.data, /^[A-Za-z0-9+/]+={0,2}$/);
	});

	it("toPiTool maps the image result to native pi content parts", async () => {
		const pi = toPiTool(readTool);
		const result = await pi.execute("call-1", { path: path.join(tmp, "dot.png") }, undefined as never);
		assert.ok(!("isError" in result) || !(result as { isError?: boolean }).isError);
		const content = (result as { content: Array<{ type: string }> }).content;
		assert.equal(content[0]!.type, "text");
		assert.equal(content[1]!.type, "image");
	});

	it("toPiTool maps plain string results to a single text part (parity)", async () => {
		const file = write("plain.txt", "body");
		const pi = toPiTool(readTool);
		const result = await pi.execute("call-2", { path: file }, undefined as never);
		const content = (result as { content: Array<{ type: string }> }).content;
		assert.equal(content.length, 1);
		assert.equal(content[0]!.type, "text");
	});
});