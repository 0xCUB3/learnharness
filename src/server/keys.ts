/**
 * The auth/keys composition (auth-keys wave, 2026-09-19): the server-side
 * key manager behind GET/PUT/DELETE /api/keys.
 *
 * THE ENV SEAM (the architecture keystone): every consumer — models.ts's
 * openRouterApiKey(), the sub-agents, web.ts, the STT route — reads
 * process.env directly, and the agent layer may not import the store
 * layer. Instead of rewiring five consumers across lanes, the store
 * REFLECTS itself into the child's env: at boot (idempotent, anchored on
 * globalThis like the extraction registry) every file var UNSET in the
 * real env is fill-gapped into process.env, and each save/delete updates
 * file + env together. Keys therefore take effect immediately — no restart
 * — which is also why main.cjs's old spawn-time injection HAD to retire:
 * an env copy made at spawn would shadow every settings-page change until
 * restart (env wins over file).
 *
 * PRECEDENCE (owner decision): real environment variables (incl.
 * .env.local in dev) always win over the file. Boot-time real-env vars
 * are snapshotted once per process and never mutated; a PUT to one of
 * them persists to the file (for when the env goes away) and the status
 * honestly reports shadowedByEnv — the page explains why the saved key
 * is not the live one.
 *
 * Unknown vars in the file are preserved verbatim and surfaced as
 * generic status rows (no catalog form to edit through — only curated
 * keys have shapes and docs; core/auth-keys.ts).
 */

import {
	AUTH_KEYS,
	type AuthKeyInfo,
	type AuthKeyStatus,
	isKnownAuthKey,
	maskKey,
	validateKeyShape,
} from "../core/auth-keys.ts";
import { authStore } from "../store/auth.ts";

// The once-per-process boot record — globalThis anchor (HMR re-imports the
// module; the snapshot must not re-run and misread fill-gapped vars as real
// env). Same pattern as globalThis.__lhExtractionRuns.
interface AuthBoot {
	/** Vars that were in the REAL env at first init — env precedence's
	 *  untouchable set. Fill-gapped vars are everything else we set. */
	realEnv: Set<string>;
	/** Vars WE put into process.env (the file's reflection) — deletable. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

function boot(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/**
 * The boot fill-gap — idempotent. First call snapshots which managed names
 * are real env; later calls (HMR re-import, or after a hand-edit) only fill
 * vars still unset in the env, so a var deleted through the API never
 * resurrects (its file entry is gone too).
 */
export function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([...Object.keys(fileVars), ...AUTH_KEYS.map((k) => k.id)]);
	if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		// First init in this process: what's already in the env is REAL env.
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

/** The managed name-space: catalog keys + whatever the file holds (unknown
 *  vars are managed too — preserved, surfaced, env-reflected — just not
 *  editable through the curated API). */
function isManagedName(name: string): boolean {
	return isKnownAuthKey(name) || name in authStore.authVars();
}

/**
 * The pure status projection — exported for tests. `env` is the live
 * process env view; `realEnv` the boot snapshot (env precedence).
 */
export function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars)]);
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		// Env wins: the live value is the env's when set (real or reflected —
		// post fill-gap the file's values LIVE in env, so realEnv is what
		// distinguishes a REAL env var from the store's own reflection).
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

/** The GET view: every curated key (present or not) + unknown file vars. */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv);
}

/** The live value for one var, env-first (the env-wins rule) — the canonical
 *  read for consumers that don't live behind the @/src/server barrel (the
 *  STT route was the one cold-boot hole: a first-ever request to it would
 *  otherwise read env before any fill-gap ran). */
export function keyValue(id: string): string | undefined {
	return process.env[id] ?? authStore.authVars()[id];
}

/**
 * Save one key (PUT). Shape gate first (owner decision: bad pastes are
 * 400s, never stored), then the file write, then the env reflection. A
 * var that the REAL env owns is not reflected (env wins — the status row
 * reports shadowedByEnv so the page can explain it).
 */
export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	const trimmed = value.trim();
	authStore.setAuthVar(id, trimmed);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = trimmed;
		record.fillGap.add(id);
	}
	// validateKeyShape guarantees catalog membership, so the row exists.
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

/**
 * Remove one key (DELETE): gone from the file always; gone from the env
 * only when the env copy was OURS (fill-gap) — a real env var stays (env
 * wins) and the status shows the key still present from env.
 */
export function deleteKey(id: string): AuthKeyStatus {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
	return keyStatuses().find((s) => s.id === id)!;
}

// Reflect the file into the env at first import (idempotent; the module is
// imported by every route/handler path that touches keys).
initAuthEnv();
