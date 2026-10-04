/**
 * THE PRACTICE TOOLS (practice sessions, owner design 2026-10-04): the
 * practice agent's ENTIRE toolset — `problem` (pose: terminates the turn;
 * the commitment rides the call's arguments, hidden from the learner UI)
 * and `conclude` (end the problem: normal result, the turn continues so
 * the same reply can reveal + pose the next). The gating law (owner
 * ruling): an agent cannot pose while a problem is active and cannot
 * conclude with nothing active — activeProblemOf is the single fold both
 * gates read.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): the tool
 * descriptions carry WHAT to pass and WHAT happens — the theory, the
 * commit-before-pose law, the hint ladder all live in the system prompt
 * (prompts/practice/10-doctrine.md).
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { activeProblemOf } from "../../core/native-messages.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { concludeResult, invalidInputResult, problemResult } from "../tool-execute.ts";

/** The record-reading context the gates need (the plan-tools idiom). */
export interface PracticeToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
}

// ─── problem: the pose ───────────────────────────────────────────────────────

export const problemInputObject = Type.Object({
	statement: Type.String({
		description:
			"REQUIRED — the problem as the learner sees it (markdown + LaTeX). Must be self-contained and " +
			"solvable from the session's material. NEVER announces the target proposition.",
	}),
	mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
		description: 'REQUIRED — the demand mode: "recall" | "discrimination" | "composition".',
	}),
	target: Type.Array(Type.String(), { minItems: 1, description: "REQUIRED — the proposition id(s) or names this problem exercises." }),
	modelSolution: Type.String({
		description: "REQUIRED — the full solution, moves in order, committed BEFORE the learner sees the problem.",
	}),
	decisionPoints: Type.Array(Type.String(), {
		description: "REQUIRED — each juncture where a not-yet-active proposition must be selected.",
	}),
	expectedWrongMoves: Type.Array(
		Type.Object({
			move: Type.String({ description: "The wrong move an honest attempt may take." }),
			resolution: Type.String({ description: "What resolves it back to the right move." }),
		}),
		{ description: "REQUIRED — the wrong moves you expect, each with its resolution." },
	),
	strategy: Type.String({ description: "REQUIRED — why this shape: the situation class, parse cost, density." }),
	rationale: Type.String({
		description: "REQUIRED — why this problem now: target + mode + difficulty against the session's last outcomes.",
	}),
});

export type ProblemInput = Static<typeof problemInputObject>;

export function problemTool(ctx: PracticeToolContext): AgentTool<typeof problemInputObject> {
	return {
		name: "problem",
		label: "problem",
		description:
			"Pose one practice problem. Ends the turn — the learner works in the thinking field; their thinking " +
			"traces and answer commits arrive back as labeled messages. The full commitment (solution, decision points, " +
			"expected wrong moves) rides this call's arguments and stays hidden from the learner until you conclude. " +
			"Only one problem may be active — conclude it before posing the next.",
		parameters: problemInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, _input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (record && activeProblemOf(record.messages) !== null) {
				return invalidInputResult("problem", [
					"a problem is already active — call conclude on it before posing the next one",
				]);
			}
			return problemResult();
		},
	};
}

// ─── conclude: the end of a problem ──────────────────────────────────────────

export const concludeInputObject = Type.Object({
	outcome: Type.Union(
		[
			Type.Literal("solved"),
			Type.Literal("solvedWithHints"),
			Type.Literal("movedOn"),
			Type.Literal("surrendered"),
			Type.Literal("dismissed"),
		],
		{ description: 'REQUIRED — "solved" | "solvedWithHints" | "movedOn" | "surrendered" ("dismissed" is synthesized, never yours).' },
	),
	verdict: Type.String({
		description: "REQUIRED — the plain-language verdict: what was credited, where it broke. On a wrong answer: localize the break, do NOT give the correction.",
	}),
	solutionReveal: Type.String({
		description: "REQUIRED — the committed solution, shown to the learner now (the reveal spend; moving on spends it).",
	}),
	rung: Type.Union(
		[Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"), Type.Literal("R4"), Type.Literal("R5"), Type.Null()],
		{ description: "REQUIRED — the hint-ladder rung the problem needed (null = no hint was given)." },
	),
	missClass: Type.Union(
		[
			Type.Literal("cue"),
			Type.Literal("discrimination"),
			Type.Literal("execution"),
			Type.Literal("careless"),
			Type.Literal("structural"),
			Type.Null(),
		],
		{ description: "REQUIRED — the miss classification (null = no miss)." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends." }),
});

export type ConcludeInput = Static<typeof concludeInputObject>;

export function concludeTool(ctx: PracticeToolContext): AgentTool<typeof concludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees " +
			"the learner's composer. The turn CONTINUES after conclude — reveal, then pose the next problem (or wrap " +
			"up in text). Nothing may conclude unless a problem is active.",
		parameters: concludeInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, _input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record || activeProblemOf(record.messages) === null) {
				return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
			}
			return concludeResult();
		},
	};
}

/** The practice toolset (the practice agent's whole registry). */
export function practiceTools(ctx: PracticeToolContext): Record<string, AgentTool<any>> {
	return {
		problem: problemTool(ctx),
		conclude: concludeTool(ctx),
	};
}
