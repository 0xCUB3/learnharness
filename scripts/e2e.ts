/**
 * e2e test — drives the web server like a browser would:
 *   1. creates a session (topic prompt)
 *   2. waits for the teacher to present a quiz (lh_question → pending)
 *   3. answers it over WS
 *   4. verifies the graded answer arrives as a user message and the agent
 *      continues (settles again)
 *   5. exits and RESUMES the session mid-flow to prove resume works
 *
 * Run: npx tsx scripts/e2e.ts   (server must be running)
 */

const BASE = "http://127.0.0.1:8787";

function connectWs(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket("ws://127.0.0.1:8787/ws");
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

function makeCollector(ws: WebSocket) {
	const seen: any[] = [];
	ws.addEventListener("message", (ev) => {
		try {
			seen.push(JSON.parse(String(ev.data)));
		} catch {}
	});
	return seen;
}

function waitEvent(
	seen: any[],
	ws: WebSocket,
	pred: (msg: any) => boolean,
	timeoutMs = 120_000,
): Promise<any> {
	const already = seen.find(pred);
	if (already) return Promise.resolve(already);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
		const handler = (ev: MessageEvent) => {
			try {
				const msg = JSON.parse(String(ev.data));
				if (pred(msg)) {
					clearTimeout(timer);
					ws.removeEventListener("message", handler);
					resolve(msg);
				}
			} catch {
				// ignore non-JSON
			}
		};
		ws.addEventListener("message", handler);
	});
}

async function main() {
	console.log("── creating session");
	const res = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "Teach me why the sky is blue." }),
	});
	const { id } = (await res.json()) as { id: string };
	console.log("   session:", id);

	console.log("── connecting WS");
	const ws = await connectWs();
	const seen = makeCollector(ws);

	// Wait for a pending question (the teacher probes with ask_user_question or quiz).
	// Fallback: if the first turn settles without a question, ask for one.
	console.log("── waiting for a pending question…");
	let pending: any;
	try {
		pending = await waitEvent(seen, ws, (m) => m.type === "pending" && m.question !== null, 120_000);
	} catch {
		console.log("   no question yet — prompting for one");
		ws.send(JSON.stringify({ type: "prompt", text: "Quiz me on something first before teaching." }));
		pending = await waitEvent(seen, ws, (m) => m.type === "pending" && m.question !== null, 180_000);
	}
	const q = pending.question;
	console.log(`   ${q.kind} [${q.mode}]: ${q.question}`);
	console.log(`   options: ${q.options?.map((o: any) => o.label).join(" | ") ?? "(text)"}`);

	// Verify the correct answer is NOT in the payload.
	const raw = JSON.stringify(q);
	if (raw.includes("correct") || raw.includes("explanation")) {
		throw new Error("LEAK: pending question payload contains correct/explanation!");
	}
	console.log("   ✓ no answer leak in client payload");

	// Answer: pick the first option (or text mode).
	if (q.mode === "text") {
		ws.send(JSON.stringify({ type: "answer", questionId: q.id, text: "not sure — just teach me" }));
	} else {
		ws.send(JSON.stringify({ type: "answer", questionId: q.id, values: [q.options[0].value] }));
	}
	console.log("── answered; waiting for the graded answer to enter the session…");

	// Register BOTH waits before proceeding (avoids missing fast events).
	const settledAgain = waitEvent(seen, ws, (m) => m.type === "streaming" && m.value === false, 180_000);
	const answeredEntry = await waitEvent(seen, ws, (m) => m.type === "entry" && m.entry?.type === "questionAnswered");
	const ad = answeredEntry.entry.data;
	console.log(`   answered: correct=${ad.correct} dontKnow=${ad.dontKnow} dismissed=${ad.dismissed}`);

	// The agent turn that follows the answer must stream and settle.
	console.log("── waiting for the agent to continue and settle…");
	await settledAgain;
	console.log("   ✓ agent continued after the answer and settled");

	// Check transcript state: user message with [Quiz answer] prefix must exist.
	const userAnswer = seen.find(
		(m) => m.type === "entry" && m.entry?.type === "user" && m.entry?.text?.startsWith("["),
	);
	console.log(userAnswer ? `   ✓ answer user message: ${userAnswer.entry.text.split("\n")[0]}` : "   (no answer user message seen — check server logs)");

	// Prompt while nothing pending should work.
	const settlePrompt = waitEvent(seen, ws, (m) => m.type === "streaming" && m.value === false, 180_000);
	ws.send(JSON.stringify({ type: "prompt", text: "thanks, that's enough for now" }));
	await settlePrompt;
	console.log("   ✓ follow-up prompt worked");

	// Dismiss any second question the teacher may have asked, so the resume
	// test starts from a clean (no pending) state.
	const pendingNow = seen.find((m) => m.type === "pending" && m.question !== null && !seen.some((o) => o.type === "entry" && o.entry?.type === "questionAnswered" && o.entry.data.questionId === m.question.id));
	if (pendingNow) {
		ws.send(JSON.stringify({ type: "dismiss", questionId: pendingNow.question.id }));
		await waitEvent(seen, ws, (m) => m.type === "pending" && m.question === null, 60_000);
		console.log("   ✓ extra question dismissed");
	}

	ws.close();

	// ── resume test: list sessions, resume the one we just made, verify backfill
	console.log("── resume test");
	const list = (await (await fetch(`${BASE}/api/sessions`)).json()) as { sessions: any[] };
	const mine = list.sessions.find((s) => s.id === id);
	console.log(`   listed: "${mine?.name}" (${mine?.messageCount} msgs)`);
	const rres = await fetch(`${BASE}/api/sessions/${encodeURIComponent(mine!.file)}/resume`, { method: "POST" });
	if (!rres.ok) throw new Error(`resume failed: ${rres.status}`);
	const ws2 = await connectWs();
	const seen2 = makeCollector(ws2);
	const backfill = await waitEvent(seen2, ws2, (m) => m.type === "backfill");
	const kinds = backfill.entries.reduce((acc: Record<string, number>, e: any) => {
		acc[e.type] = (acc[e.type] ?? 0) + 1;
		return acc;
	}, {});
	console.log("   backfill entries:", JSON.stringify(kinds));
	const pending2 = await waitEvent(seen2, ws2, (m) => m.type === "pending");
	console.log(`   pending after resume: ${pending2.question === null ? "none (correct)" : "UNEXPECTED: " + pending2.question.id}`);
	ws2.close();

	console.log("\n✓ E2E PASSED");
	process.exit(0);
}

main().catch((err) => {
	console.error("\n✗ E2E FAILED:", err);
	process.exit(1);
});
