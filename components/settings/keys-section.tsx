"use client";
/**
 * The Keys section (auth/provider-keys wave, 2026-09-20): BYOK keys over
 * the merged auth API — GET /api/keys (masked statuses, never plaintext),
 * PUT /api/keys/:id (shape-gated 400s), DELETE /api/keys/:id. Saves take
 * effect immediately (file + env reflection, no restart).
 *
 * Two groups (owner design):
 *  - Model providers — free-form, pi-compatible. OpenRouter is pinned as
 *    an always-visible row (the app's lifeline: every model call today),
 *    other providers appear when stored, and an Add-provider dropdown
 *    lists every pi-ai provider that takes an API key. The list arrives as
 *    GET /api/keys' optional `providers` array (Platform interlude; the
 *    rolePins pattern — absent = the dropdown waits, everything else
 *    works). Provider ids/env vars come from pi-ai's own table, so this
 *    UI cannot drift from what pi actually reads.
 *  - Tools & services — the curated rows: Deepgram (dictation) and the
 *    Google pair (search key + CSE ID), each with description + docs
 *    link (opens in the real browser; the Electron shell routes it).
 *
 * Owner UX decisions: always-visible paste inputs (no reveal affordance —
 * plaintext never returns from the store, masked tail + length only);
 * bad pastes show the server's format message inline; a dev .env.local
 * variable beats the saved file value and the row says so honestly.
 *
 * Unknown auth.json vars surface as read-only dimmed rows — preserved by
 * the store (forward-compat), not editable through the curated surface.
 */

import { useEffect, useState } from "react";
import { type AuthKeyStatus } from "@/src/core";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

/** One pi-ai provider with plain API-key auth (the Platform seam). */
export interface ProviderKeyInfo {
	/** pi-ai provider id ("groq", "deepseek", …). */
	id: string;
	/** The env var / auth.json key a paste writes ("GROQ_API_KEY", …). */
	envVar: string;
	label: string;
}

/** GET /api/keys — merged shape plus the interlude's optional array. */
interface KeysResponse {
	keys: AuthKeyStatus[];
	providers?: ProviderKeyInfo[];
}

/** The OpenRouter row survives its curated-catalog graduation: the label
 *  is pinned here so the row reads correctly even when the catalog no
 *  longer carries it (first boot: absent, not even a status row). */
const OPENROUTER_ID = "OPENROUTER_API_KEY";
const OPENROUTER_FALLBACK = {
	label: "OpenRouter",
	description: "The main model key — every teacher, prober and sub-agent call goes through it.",
	docsUrl: "https://openrouter.ai/settings/keys",
};

/** The curated tools group, pinned by id (the catalog owns the copy;
 *  these ids are the contract). */
const TOOL_IDS = ["DEEPGRAM_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_CSE_ID"] as const;

/** The classification that drives the section's two groups. Pure —
 *  exported for tests. */
export function classifyKeys(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): {
	openrouter: AuthKeyStatus;
	/** Stored non-OpenRouter provider keys, with their provider entry. */
	providerRows: { status: AuthKeyStatus; provider?: ProviderKeyInfo }[];
	/** The curated tools rows (synthesized when absent = first boot). */
	toolRows: AuthKeyStatus[];
	/** Unknown file vars — preserved, read-only. */
	unknownRows: AuthKeyStatus[];
	/** Providers without a stored key — the Add dropdown's options. */
	addable: ProviderKeyInfo[];
} {
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const providerByEnv = new Map((providers ?? []).map((p) => [p.envVar, p]));
	const synth = (id: string): AuthKeyStatus => ({
		id,
		info: null,
		present: false,
		masked: null,
		source: "none",
		shadowedByEnv: false,
	});
	const isTool = (id: string) => (TOOL_IDS as readonly string[]).includes(id);
	const providerRows: { status: AuthKeyStatus; provider?: ProviderKeyInfo }[] = [];
	const unknownRows: AuthKeyStatus[] = [];
	for (const s of statuses) {
		if (s.id === OPENROUTER_ID || isTool(s.id)) continue;
		const provider = providerByEnv.get(s.id);
		if (provider) providerRows.push({ status: s, provider });
		else if (!s.info) unknownRows.push(s);
		// a curated-but-present status outside the pinned ids: treat as a
		// provider row (pre-interlude the catalog only has the pinned ids).
		else providerRows.push({ status: s });
	}
	return {
		openrouter: byId.get(OPENROUTER_ID) ?? synth(OPENROUTER_ID),
		providerRows,
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows,
		addable: (providers ?? []).filter((p) => p.envVar !== OPENROUTER_ID && !byId.has(p.envVar)),
	};
}

/** The masked status line, e.g. "…ab12 · 64 chars · saved" — the row's
 *  at-a-glance state. Pure — tests. */
export function keyStatusLine(status: AuthKeyStatus): string | null {
	if (!status.present || !status.masked) return null;
	const where = status.source === "env" ? "environment" : "saved";
	return `${status.masked.replace(/ \(\d+ chars\)$/, "")} · ${status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?"} chars · ${where}`;
}

/** One editable key row: status + paste input + Save + (Delete when
 *  present). The 400 message lands inline under the input. */
function KeyEditorRow({
	label,
	hint,
	docsUrl,
	status,
	onSave,
	onDelete,
	testid,
}: {
	label: string;
	hint?: string;
	docsUrl?: string;
	status: AuthKeyStatus;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	testid: string;
}) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const statusLine = keyStatusLine(status);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	return (
		<div data-testid={testid}>
			<SettingsRow label={label} hint={hint} testid={`${testid}-row`}>
				{statusLine && (
					<span
						data-testid={`${testid}-status`}
						className="font-mono text-[11px] text-muted-foreground"
					>
						{statusLine}
						{status.shadowedByEnv && (
							<span className="text-foreground"> — an environment variable owns this name; the saved value is stored but not live</span>
						)}
					</span>
				)}
				<a
					href={docsUrl ?? "about:blank"}
					target="_blank"
					rel="noreferrer"
					aria-disabled={!docsUrl}
					onClick={docsUrl ? undefined : (e) => e.preventDefault()}
					className={`text-[11px] underline-offset-2 hover:underline ${docsUrl ? "text-muted-foreground hover:text-foreground" : "invisible"}`}
				>
					Get a key ↗
				</a>
			</SettingsRow>
			<div className="mt-1 flex items-center gap-2 pl-6">
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void save();
					}}
					placeholder="Paste key…"
					aria-label={`${label} key`}
					data-testid={`${testid}-input`}
					disabled={busy}
					className="h-7 w-72 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>
				<button
					type="button"
					onClick={() => void save()}
					disabled={busy || !value.trim()}
					data-testid={`${testid}-save`}
					className="text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
				>
					Save
				</button>
				{status.present && onDelete && (
					<button
						type="button"
						onClick={() => void onDelete()}
						disabled={busy}
						data-testid={`${testid}-delete`}
						className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
					>
						Delete
					</button>
				)}
			</div>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="mt-1 pl-6 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}

export function KeysSection() {
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [providers, setProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	/** The provider chosen in the Add dropdown, if any. */
	const [adding, setAdding] = useState<ProviderKeyInfo | null>(null);
	const [loading, setLoading] = useState(true);

	const reload = () =>
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: KeysResponse) => {
				setStatuses(body.keys ?? []);
				if (body.providers) setProviders(body.providers);
			})
			.catch(() => setStatuses([]))
			.finally(() => setLoading(false));

	useEffect(() => {
		void reload();
	}, []);

	async function saveKey(id: string, value: string): Promise<string | null> {
		const res = await fetch(`/api/keys/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return body.error ?? `Save failed (${res.status})`;
		}
		await reload();
		return null;
	}

	async function deleteKey(id: string): Promise<void> {
		await fetch(`/api/keys/${id}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
	}

	if (loading || statuses === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading keys…</p>;
	}

	const { openrouter, providerRows, toolRows, unknownRows, addable } = classifyKeys(statuses, providers);
	const envWarning = openrouter.shadowedByEnv;

	return (
		<>
			<SettingsGroup label="Model providers" testid="group-provider-keys">
				<KeyEditorRow
					label={openrouter.info?.label ?? OPENROUTER_FALLBACK.label}
					hint={openrouter.info?.description ?? OPENROUTER_FALLBACK.description}
					docsUrl={openrouter.info?.docsUrl ?? OPENROUTER_FALLBACK.docsUrl}
					status={openrouter}
					testid="key-openrouter"
					onSave={(v) => saveKey(OPENROUTER_ID, v)}
					onDelete={() => deleteKey(OPENROUTER_ID)}
				/>
				{providerRows.map(({ status, provider }) => (
					<KeyEditorRow
						key={status.id}
						label={provider?.label ?? status.id}
						hint={status.info?.description ?? provider?.id}
						docsUrl={status.info?.docsUrl}
						status={status}
						testid={`key-${provider?.id ?? status.id.toLowerCase()}`}
						onSave={(v) => saveKey(status.id, v)}
						onDelete={() => deleteKey(status.id)}
					/>
				))}
				{providers === undefined ? (
					<p className="text-xs text-muted-foreground/60" data-testid="providers-pending">
						The full provider list ships with the server update.
					</p>
				) : (
					<div className="mt-1 pl-6" data-testid="add-provider">
						<div className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground">Add provider key</span>
							<select
								aria-label="Add provider key"
								data-testid="add-provider-select"
								value={adding?.id ?? ""}
								onChange={(e) => {
									const next = addable.find((p) => p.id === e.target.value) ?? null;
									setAdding(next);
								}}
								className="h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
							>
								<option value="">Choose a provider…</option>
								{addable.map((p) => (
									<option key={p.id} value={p.id}>
										{p.label} ({p.envVar})
									</option>
								))}
							</select>
						</div>
						{adding && (
							<div className="mt-2">
								<KeyEditorRow
									label={adding.label}
									hint={adding.id}
									status={statuses.find((s) => s.id === adding.envVar) ?? {
										id: adding.envVar,
										info: null,
										present: false,
										masked: null,
										source: "none" as const,
										shadowedByEnv: false,
									}}
									testid={`key-${adding.id}`}
									onSave={(v) => saveKey(adding.envVar, v)}
									onDelete={() => deleteKey(adding.envVar)}
								/>
							</div>
						)}
					</div>
				)}
				{envWarning && (
					<p className="text-xs text-foreground" data-testid="openrouter-shadowed">
						The environment variable {OPENROUTER_ID} is set — it wins over any key saved here.
					</p>
				)}
			</SettingsGroup>

			<SettingsGroup label="Tools & services" testid="group-tool-keys">
				{toolRows.map((status) => (
					<KeyEditorRow
						key={status.id}
						label={status.info?.label ?? status.id}
						hint={status.info?.description}
						docsUrl={status.info?.docsUrl}
						status={status}
						testid={`key-${status.id.toLowerCase()}`}
						onSave={(v) => saveKey(status.id, v)}
						onDelete={() => deleteKey(status.id)}
					/>
				))}
			</SettingsGroup>

			{unknownRows.length > 0 && (
				<SettingsGroup label="Other stored variables" testid="group-unknown-keys">
					{unknownRows.map((status) => (
						<SettingsRow
							key={status.id}
							label={status.id}
							hint="preserved from auth.json — read-only"
							testid={`unknown-${status.id}`}
							dimmed
						>
							<span className="font-mono text-[11px] text-muted-foreground">{status.masked}</span>
						</SettingsRow>
					))}
				</SettingsGroup>
			)}
		</>
	);
}
