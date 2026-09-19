import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { lhTool } from "../lh-tool.ts";
import {
	capOutput,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	isBinaryFile,
	matchGlob,
	MAX_OUTPUT_BYTES,
	resolveSourcePath,
	truncateGrepLine,
	walkFiles,
} from "./fs-shared.ts";

/**
 * The grep tool — sources v1 (2026-09-19): pi's dist/core/tools/grep.js
 * ported to a pure-Node scan (pi shells out to rg). Schemas and output
 * formats are pi-verbatim — `relative/path:LINE: text` matches,
 * `relative/path-LINE- text` context lines, the 500-char line cap, the
 * "use read to see full lines" notice. Deltas: home-anchored default,
 * .gitignore replaced by hard noise exclusions, binary detection via NUL
 * sniff, a 2MB file cap, and a wall-clock timeout with partial results.
 * Read-only by construction.
 */

const DEFAULT_LIMIT = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const grepInputSchema = z.object({
	pattern: z.string().min(1).describe("Search pattern (regex or literal string)"),
	path: z
		.string()
		.optional()
		.describe("Directory or file to search (default: the learner's home directory)"),
	glob: z.string().optional().describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),
	ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
	literal: z.boolean().optional().describe("Treat pattern as literal string instead of regex (default: false)"),
	context: z.number().int().nonnegative().optional().describe("Number of lines to show before and after each match (default: 0)"),
	limit: z.number().int().positive().optional().describe("Maximum number of matches to return (default: 100)"),
});

export const grepTool = lhTool({
	name: "grep",
	description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Ignores node_modules, .git, and Library directories. Output is truncated to ${DEFAULT_LIMIT} matches or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	schema: grepInputSchema,
	async execute(input) {
		const searchPath = resolveSourcePath(input.path);

		let stat;
		try {
			stat = await fs.stat(searchPath);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
		const isDirectory = stat.isDirectory();

		const regex = new RegExp(
			input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern,
			input.ignoreCase ? "i" : undefined,
		);
		const contextValue = input.context && input.context > 0 ? input.context : 0;
		const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);

		// Files to scan: one explicit file, or the walked tree (glob-filtered).
		const files: string[] = [];
		let timedOut = false;
		if (!isDirectory) {
			files.push(searchPath);
		} else {
			const result = await walkFiles(
				searchPath,
				(filePath) => {
					if (input.glob) {
						const rel = path.relative(searchPath, filePath).split(path.sep).join("/");
						if (!matchGlob(rel, input.glob)) return false;
					}
					files.push(filePath);
					return false;
				},
			);
			timedOut = result.timedOut;
		}

		const outLines: string[] = [];
		let matchCount = 0;
		let limitReached = false;
		let linesTruncated = false;

		for (const filePath of files) {
			if (matchCount >= effectiveLimit) {
				limitReached = true;
				break;
			}
			let fileStat;
			try {
				fileStat = await fs.stat(filePath);
			} catch {
				continue;
			}
			if (fileStat.size > MAX_FILE_BYTES) continue; // rg-style silent skip of huge files
			if (await isBinaryFile(filePath).catch(() => true)) continue;

			let content: string;
			try {
				content = await fs.readFile(filePath, "utf-8");
			} catch {
				continue;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const rel = isDirectory
				? path.relative(searchPath, filePath).split(path.sep).join("/")
				: path.basename(filePath);

			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i]!)) {
					if (matchCount >= effectiveLimit) {
						limitReached = true;
						break;
					}
					matchCount++;
					const start = contextValue > 0 ? Math.max(1, i + 1 - contextValue) : i + 1;
					const end = contextValue > 0 ? Math.min(lines.length, i + 1 + contextValue) : i + 1;
					for (let current = start; current <= end; current++) {
						const { text, wasTruncated } = truncateGrepLine(lines[current - 1] ?? "");
						if (wasTruncated) linesTruncated = true;
						// pi's format: ':' for match lines, '-' for context lines.
						outLines.push(current === i + 1 ? `${rel}:${current}: ${text}` : `${rel}-${current}- ${text}`);
					}
				}
			}
			if (limitReached) break;
		}

		if (outLines.length === 0) {
			return timedOut
				? `Search timed out after 10s with no matches yet. Narrow the search to a subdirectory.`
				: "No matches found";
		}
		const { content, truncated } = capOutput(outLines);
		const notices: string[] = [];
		if (limitReached || matchCount >= effectiveLimit) notices.push(`${effectiveLimit} matches limit reached`);
		if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit reached`);
		if (timedOut) notices.push("search timed out after 10s — partial results, narrow the directory");
		return notices.length > 0 ? `${content}\n\n[${notices.join(". ")}]` : content;
	},
});
