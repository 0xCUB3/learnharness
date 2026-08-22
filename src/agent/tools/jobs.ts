import type { ToolSet } from "ai";
import type { TeacherToolContext } from "../tools.ts";

/**
 * Async sub-agent job tools — W2 workstream (research; W6 adds demo + visual).
 * CLIENT-SIDE semantics (no execute): the turn ends with the part pending, a
 * background runner fulfills it, and the client continuation resumes the
 * teacher. See src/core/contracts.ts "THE ASYNC PROTOCOL" — read it first.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function jobTools(ctx: TeacherToolContext): ToolSet {
	return {};
}
