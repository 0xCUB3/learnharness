/**
 * Job abort registry — WHO can actually kill a running sub-agent.
 *
 * The runner creates one AbortController per running job and registers it
 * here; the abort path (src/server/jobs.ts abortJob, driven by the dock's
 * END button via POST /api/jobs/[jobId]/abort) fires it through fireJobAbort.
 * Two module trees meet: the runner (src/agent) and the endpoint
 * (src/server) — the registry lives on globalThis for the same reason as
 * the turn registry and the wake pipeline: Next dev gives each route entry
 * its own module instances, so a module-level Map would be a different
 * object in each. Placed under src/agent (server→agent imports are an
 * established direction; agent→server is not — see chat-handler).
 *
 * 2026-09 abort semantics (user-decided): REAL KILL, not mark-and-abandon —
 * the controller aborts the in-flight model call (agent.generate /
 * generateText abortSignal); headless tool runs are best-effort (the next
 * model call is where a hung one dies). The route owns the bookkeeping
 * (status error "Aborted by learner" + the abort steer); the runner only unwinds.
 */

interface LhAbortGlobal {
	__lhJobAborts?: Map<string, AbortController>;
}

function registry(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhAbortGlobal;
	return (g.__lhJobAborts ??= new Map());
}

/** The runner registers its controller at job start (idempotent overwrite). */
export function registerJobAbort(jobId: string, controller: AbortController): void {
	registry().set(jobId, controller);
}

/** The runner unregisters in its finally block (job settled or unwound). */
export function unregisterJobAbort(jobId: string): void {
	registry().delete(jobId);
}

/** Abort a running job's loop. Returns false when no controller is live —
 * the job's loop is not executing (crashed, or in the delivering-result
 * phase where the runner has already returned); the caller then owns the
 * whole abort on the record side. */
export function fireJobAbort(jobId: string): boolean {
	const controller = registry().get(jobId);
	if (!controller) return false;
	registry().delete(jobId);
	controller.abort();
	return true;
}
