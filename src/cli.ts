#!/usr/bin/env node
/**
 * learning-harness CLI
 *
 *   teach [message]   launch an interactive teaching session (full pi TUI)
 *   doctor [--web]    non-interactive smoke test of the teacher wiring
 *                     (--web checks the web-dispatch extension set)
 *   serve             start the web server (teacher agent + REST + WebSocket)
 *   ingest <file>     normalize a session JSONL and print the canonical document
 *                     (Stage 1 only — extractor/merger not yet implemented)
 *   graph             print graph/ledger stats
 *   what-next         (not yet implemented)
 */

import * as fs from "node:fs";
import { doctor, runTeachingSession } from "./teacher/create-session.ts";
import { normalizeSession } from "./extract/normalize.ts";
import { ledgers } from "./ledger.ts";
import { deriveAll } from "./derive.ts";
import { PATHS } from "../config.ts";

async function main() {
	const [command, ...rest] = process.argv.slice(2);

	switch (command) {
		case "teach": {
			await runTeachingSession(rest.join(" ") || undefined);
			break;
		}
		case "doctor": {
			const mode = rest.includes("--web") ? "web" : "tui";
			await doctor(mode);
			break;
		}
		case "ingest": {
			const file = rest[0];
			if (!file) {
				console.error("Usage: ingest <session.jsonl>");
				process.exit(1);
			}
			const doc = normalizeSession(file);
			ledgers.appendSession(doc.session);
			console.log(`Session: ${doc.session.id}`);
			console.log(`Topic:   ${doc.session.topic}`);
			console.log(`Entries: ${doc.entries.length}`);
			const quizzes = doc.entries.filter((e) => e.kind === "quiz");
			console.log(`Quizzes: ${quizzes.length}`);
			// Full canonical document for inspection / later pipeline stages.
			fs.mkdirSync(PATHS.graph, { recursive: true });
			const out = `${PATHS.graph}/canonical-${doc.session.id.slice(0, 8)}.json`;
			fs.writeFileSync(out, JSON.stringify(doc, null, "\t"), "utf-8");
			console.log(`Canonical document written: ${out}`);
			break;
		}
		case "graph": {
			const nodes = ledgers.nodes();
			const edges = ledgers.edges();
			const events = ledgers.events();
			const sessions = ledgers.sessions();
			const derived = deriveAll();
			console.log(`Sessions: ${sessions.length}`);
			console.log(`Nodes:    ${nodes.length} (known: ${derived.filter((d) => d.known).length})`);
			console.log(`Edges:    ${edges.length}`);
			console.log(`Events:   ${events.length}`);
			break;
		}
		case "what-next": {
			console.error("Not implemented yet — needs extractor + merger first.");
			process.exit(1);
		}
		default: {
			console.log("Commands: teach [message] | doctor | ingest <file> | graph | what-next");
			process.exit(command ? 1 : 0);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
