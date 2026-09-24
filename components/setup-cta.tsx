"use client";
/**
 * The zero-keys surfaces (zero-keys wave, 2026-09-25, owner-locked over
 * Platform's 66dbea9 key-presence gate): when NO model-provider key
 * exists, chat / home / /chat/new hoist a composer pill — "Add a
 * provider key" — that takes PRECEDENCE over the models setup CTA
 * (keys come first in the chain: the model pickers list only what
 * keys unlock). Click opens the SetupDialog, whose stage derives to
 * the first-key screen on its own.
 *
 * Truth: GET /api/keys — a PROVIDER key present (env or file; tool keys
 * like Deepgram do not count — they unlock no models). Live updates ride
 * the lh:settings-saved "keys" signal (keys-section dispatches after
 * save AND delete; the setup dialog's first-key screen dispatches on
 * its own save), the same re-read pattern chat.tsx uses for "models".
 */

import { useCallback, useEffect, useState } from "react";
import type { AuthKeyStatus } from "@/src/core";
import { classifyKeys, type ProviderKeyInfo } from "@/components/settings/keys-section";
import { useSettingsSaved } from "@/components/settings-signal";

/** Pure: does a MODEL-PROVIDER key exist among the statuses? Reuses
 *  classifyKeys (the keys section's own classification — no drift):
 *  a status whose id is a provider env-var (or the pre-interlude
 *  fallback shape) with present=true counts, present or file-sourced,
 *  env-owned included (env wins but it EXISTS). Exported for pins. */
export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): boolean {
	return classifyKeys(statuses, providers).providerRows.some((s) => s.present);
}

/** The zero-keys truth for the calling page: TRUE only after a
 *  successful read says no provider key exists (pending and failed
 *  reads render nothing — the pill must never flash on a gap, and a
 *  failed read claiming "zero keys" would be a lie the CTA flow then
 *  leans on). Re-reads on the keys signal. */
export function useZeroKeys(): boolean {
	const [zeroKeys, setZeroKeys] = useState(false);
	const read = useCallback(() => {
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys?: AuthKeyStatus[]; providers?: ProviderKeyInfo[] }) => {
				setZeroKeys(!hasProviderKey(body.keys ?? [], body.providers));
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "keys") read();
	});
	return zeroKeys;
}

/** The pill itself — the models CTA's chrome and placement, the keys
 *  chain's copy. testid "setup-cta-keys" (the models CTA keeps
 *  "setup-cta"; probes can tell them apart). */
export function ZeroKeysPill({ onOpen }: { onOpen: () => void }) {
	return (
		<div className="pointer-events-auto mb-2 flex justify-center">
			<button
				type="button"
				data-testid="setup-cta-keys"
				onClick={onOpen}
				className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
			>
				Add a provider key — chats start after one unlocks the models
			</button>
		</div>
	);
}