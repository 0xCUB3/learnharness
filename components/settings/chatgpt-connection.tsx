"use client";

import { useEffect, useState } from "react";
import type { ChatGPTStatus } from "@/src/core";

export const CHATGPT_NOTICE = "LearnHarness stores your ChatGPT account details and encrypted credentials locally on this device. When this connection is used, relevant conversation context, learning material, and tool results are sent directly to OpenAI. ChatGPT plan limits apply; any additional credits are authorized and managed in ChatGPT, not LearnHarness.";
const empty: ChatGPTStatus = { available: false, pending: false, activeId: null, accounts: [], error: null };

/** Status/control surface only; OAuth URLs, codes, and tokens never reach React. */
export function ChatGPTConnection() {
	const [status, setStatus] = useState<ChatGPTStatus>(empty);
	const [selected, setSelected] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		let mounted = true;
		const refresh = async () => {
			try {
				const next = await bridge.status();
				if (!mounted) return;
				setStatus(next);
				setSelected((old) => old || next.activeId || "");
			} catch { if (mounted) setError("The desktop connection is unavailable. Retry when the app is ready."); }
		};
		void refresh();
		const off = bridge.onChange(() => void refresh());
		return () => { mounted = false; off(); };
	}, []);
	const account = status.accounts.find((a) => a.id === selected);
	async function control(action: () => Promise<ChatGPTStatus>) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const next = await action();
			if (typeof next.available === "boolean") setStatus(next);
			setError(next.error ?? null);
		} catch { setError("The ChatGPT connection could not be changed. Try again."); }
		finally { setBusy(false); }
	}
	const bridge = typeof window !== "undefined" ? window.lh?.chatgpt : undefined;
	return (
		<div className="flex flex-col gap-3" data-testid="chatgpt-connection">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">ChatGPT</span>
				<span className="text-xs text-muted-foreground" role="status">{status.pending ? "Waiting for browser sign-in…" : status.accounts.some((a) => a.id === status.activeId && a.connected) ? "ChatGPT plan connection" : "Not connected"}</span>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground" data-testid="chatgpt-privacy-notice">{CHATGPT_NOTICE}</p>
			<div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
				<a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer" className="underline underline-offset-2">OpenAI privacy</a>
				<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">Manage usage</a>
			</div>
			{status.accounts.length > 0 && (
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Saved ChatGPT account / registration
					<select aria-label="Saved ChatGPT account" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy || status.pending} className="rounded-sm border border-border bg-background px-2 py-1.5 text-foreground">
						<option value="">Add another account or workspace</option>
						{status.accounts.map((item) => <option key={item.id} value={item.id}>{item.email} · registration {item.registration}{item.id === status.activeId ? " · active" : ""}</option>)}
					</select>
					<span>Registrations can belong to different workspaces. An email does not identify a workspace.</span>
				</label>
			)}
			<div className="flex flex-wrap items-center gap-3">
				{/* Official black/white format and unmodified OpenAI-provided mark. */}
				<button type="button" data-testid="chatgpt-login" disabled={!status.available || busy || status.pending} onClick={() => bridge && void control(() => bridge.login(selected || undefined))} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-white/20 bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src="/siwc/chatgpt-logo-white.svg" width="21" height="21" alt="" aria-hidden="true" />
					Continue with ChatGPT
				</button>
				{status.pending && <button type="button" onClick={() => bridge && void control(() => bridge.cancel())} className="text-xs underline underline-offset-2">Cancel sign-in</button>}
				{account?.connected && selected !== status.activeId && <button type="button" disabled={busy || status.pending} onClick={() => bridge && void control(() => bridge.select(selected))} className="text-xs underline underline-offset-2">Use this account</button>}
				{account && <button type="button" disabled={busy} onClick={() => bridge && void control(() => bridge.logout(selected))} className="text-xs underline underline-offset-2">Disconnect</button>}
			</div>
			{!status.available && <p className="text-xs text-muted-foreground">ChatGPT sign-in is available only in the desktop app with secure OS credential storage. API-key connections remain available here.</p>}
			{account && (
				<label className="flex items-start gap-2 text-xs text-foreground">
					<input type="checkbox" checked={account.background} disabled={busy || !status.available || status.pending} onChange={(event) => bridge && void control(() => bridge.consent(account.id, event.target.checked))} className="mt-0.5" />
					<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">Allow extraction, compaction, delegated jobs, and automatic follow-up work to use this ChatGPT connection.</span></span>
				</label>
			)}
			{(error || status.error || status.catalogError) && <p role="alert" className="text-xs text-red-400">{error || status.error || status.catalogError}</p>}
		</div>
	);
}
