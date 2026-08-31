/**
 * Server-side turn liveness: which chats currently have a teacher turn in
 * flight. The missing half of "sessions keep running in the background" —
 * together with the write-ahead persist in chat-handler, a returning client
 * can tell "the teacher is mid-turn — don't resurrect, don't start anything"
 * apart from "the record IS current".
 *
 * In-memory BY DESIGN: a process restart clears it, so there are no stale
 * flags to clean up — a crashed turn recovers via the write-ahead record +
 * mount continuation on the next visit. The TTL is a leak guard for the
 * pathological case where onFinish never fires (it runs even on aborts);
 * chat turns are minutes at most, so 30 minutes is far on the safe side.
 */

const inFlight = new Map<string, number>(); // chatId → startedAt (epoch ms)
const MAX_TURN_MS = 30 * 60_000;

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 */
export function beginTurn(chatId: string): boolean {
	if (isTurnRunning(chatId)) return false;
	inFlight.set(chatId, Date.now());
	return true;
}

/** Mark the chat's turn as finished (runs in onFinish, aborted or not). */
export function endTurn(chatId: string): void {
	inFlight.delete(chatId);
}

/** True while the chat's turn is in flight; lazily evicts stale entries. */
export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		return false;
	}
	return true;
}
