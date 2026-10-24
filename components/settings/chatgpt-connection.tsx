"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatGPTStatus } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export const CHATGPT_NOTICE = "LearnHarness stores your ChatGPT account details and encrypted credentials locally on this device. When this connection is used, relevant conversation context, learning material, and tool results are sent directly to OpenAI. ChatGPT plan limits apply; any additional credits are authorized and managed in ChatGPT, not LearnHarness.";
export const CHATGPT_BACKGROUND_HINT = "Background work uses your ChatGPT allowance.";
const REVOCATION_WARNING = "Signed out locally. Remote revocation was not confirmed; disconnect LearnHarness in ChatGPT Settings.";
const empty: ChatGPTStatus = { available: false, pending: false, activeId: null, accounts: [], error: null };
type Account = ChatGPTStatus["accounts"][number];
type Dialog = { kind: "connect" } | { kind: "manage"; accountId: string } | { kind: "warning" };
type LoginAttempt = { generation: number; dialog: Dialog; registration: string; background: boolean; pending: boolean; accountId?: string; phase: "starting" | "pending" | "consent" };
const CONTROL_ERROR = "The ChatGPT connection could not be changed. Try again.";
function isStatus(value: unknown): value is ChatGPTStatus {
	if (!value || typeof value !== "object") return false;
	const s = value as ChatGPTStatus;
	return typeof s.available === "boolean" && typeof s.pending === "boolean" && (s.activeId === null || typeof s.activeId === "string") &&
		(s.error === null || typeof s.error === "string") && (s.catalogError == null || typeof s.catalogError === "string") && Array.isArray(s.accounts) &&
		s.accounts.every((a) => a && typeof a.id === "string" && typeof a.email === "string" && typeof a.registration === "string" && typeof a.connected === "boolean" && typeof a.background === "boolean" && (a.planEnabled === undefined || typeof a.planEnabled === "boolean"));
}
function replyError(value: unknown): string {
	return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : CONTROL_ERROR;
}
const Context = createContext({
	status: empty,
	busy: false,
	error: null as string | null,
	inlineError: null as string | null,
	warning: null as string | null,
	connect: () => {},
	manage: (_id: string) => {},
	select: (_id: string) => {},
	dismissWarning: () => {},
});

/** UI lifetime spans setup's keys → models transition. Only existing safe controls
 * are used; account IDs remain control values, never displayed account labels. */
export function ChatGPTUIProvider({ children }: { children: React.ReactNode }) {
	const [status, setStatus] = useState<ChatGPTStatus>(empty);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dismissedError, setDismissedError] = useState<string | null>(null);
	const [background, setBackground] = useState(false);
	const [registration, setRegistration] = useState("");
	const operation = useRef<"login" | "cancel" | "change" | "logout" | null>(null);
	const generation = useRef(0);
	const statusSequence = useRef(0);
	const mounted = useRef(false);
	const dialogRef = useRef<Dialog | null>(null);
	const statusRef = useRef(status);
	const loginAttempt = useRef<LoginAttempt | null>(null);
	const receive = useRef<(value: unknown) => void>(() => {});
	function showDialog(next: Dialog | null) { dialogRef.current = next; setDialog(next); }
	function publishStatus(value: unknown): ChatGPTStatus | null {
		if (!isStatus(value)) { setError(replyError(value)); return null; }
		statusSequence.current++; statusRef.current = value; setStatus(value);
		return value;
	}
	function owns(attempt: LoginAttempt) { return mounted.current && loginAttempt.current === attempt && generation.current === attempt.generation; }
	function finish(attempt: LoginAttempt) {
		if (!owns(attempt)) return;
		loginAttempt.current = null; operation.current = null; setBusy(false);
	}
	async function complete(attempt: LoginAttempt, next: ChatGPTStatus) {
		const account = next.accounts.find((a) => a.id === next.activeId && a.connected);
		if (next.error || !next.available || !account || (attempt.registration && account.id !== attempt.registration)) {
			finish(attempt); setError(next.error || CONTROL_ERROR); return;
		}
		attempt.phase = "consent"; attempt.accountId = account.id;
		try {
			if (account.background !== attempt.background) {
				operation.current = "change";
				const result: unknown = await window.lh!.chatgpt!.consent(account.id, attempt.background);
				if (!owns(attempt)) return;
				const saved = publishStatus(result);
				if (!saved) { finish(attempt); return; }
				next = saved;
			}
			if (!owns(attempt)) return;
			const current = next.accounts.find((a) => a.id === account.id && a.id === next.activeId && a.connected);
			if (next.error || next.pending || !next.available || !current || current.background !== attempt.background) setError(next.error || CONTROL_ERROR);
			else if (dialogRef.current === attempt.dialog) showDialog(null);
		} catch { if (owns(attempt)) setError(CONTROL_ERROR); }
		finally { finish(attempt); }
	}
	function reconcile(next: ChatGPTStatus, loginReply = false) {
		const attempt = loginAttempt.current;
		if (!attempt || !owns(attempt)) return;
		if (attempt.phase === "consent") {
			if (next.pending || next.error || !next.available || next.activeId !== attempt.accountId || !next.accounts.some((a) => a.id === attempt.accountId && a.connected)) {
				finish(attempt); setError(next.error || CONTROL_ERROR);
			}
			return;
		}
		if (next.pending) { attempt.pending = true; attempt.phase = "pending"; return; }
		// login() normally acknowledges pending immediately; verified completion is
		// a later status notification. The acknowledgement itself is not success.
		if (attempt.pending || loginReply) void complete(attempt, next);
	}
	receive.current = (value) => {
		const next = publishStatus(value);
		if (next) reconcile(next);
	};
	useEffect(() => {
		mounted.current = true;
		const bridge = window.lh?.chatgpt;
		const refresh = async () => {
			const request = ++statusSequence.current;
			try {
				const next: unknown = await bridge?.status();
				if (next && mounted.current && request === statusSequence.current) receive.current(next);
			} catch { if (mounted.current && request === statusSequence.current) setError("The desktop connection is unavailable. Retry when the app is ready."); }
		};
		void refresh();
		const off = bridge?.onChange(() => void refresh());
		return () => { mounted.current = false; generation.current++; loginAttempt.current = null; off?.(); };
	}, []);

	const managed = dialog?.kind === "manage" ? status.accounts.find((a) => a.id === dialog.accountId && a.connected) : undefined;
	const visibleError = error || (status.error !== dismissedError ? status.error : null) || status.catalogError || null;
	const warning = visibleError === REVOCATION_WARNING ? visibleError : null;
	function openConnect() {
		if (operation.current) return;
		setBackground(false);
		setRegistration("");
		setError(null);
		setDismissedError(status.error);
		showDialog({ kind: "connect" });
	}
	function close() {
		if (operation.current === "logout" || operation.current === "change" || operation.current === "cancel") return;
		const cancel = loginAttempt.current !== null || statusRef.current.pending;
		const intent = ++generation.current;
		const owner = dialogRef.current;
		loginAttempt.current = null;
		if (!cancel) showDialog(null);
		setError(null);
		setDismissedError(status.error);
		if (cancel) {
			// Keep cancellation serialized even after login's pending IPC reply.
			operation.current = "cancel"; setBusy(true);
			void window.lh?.chatgpt?.cancel().then((value: unknown) => {
				if (!mounted.current || generation.current !== intent) return;
				const next = publishStatus(value);
				if (next && !next.pending) {
					setDismissedError(next.error);
					if (dialogRef.current === owner) showDialog(null);
				} else if (next) setError(CONTROL_ERROR);
			}).catch(() => { if (mounted.current && generation.current === intent) setError(CONTROL_ERROR); }).finally(() => {
				if (mounted.current && generation.current === intent) { operation.current = null; setBusy(false); }
			});
		}
	}
	async function control(kind: "change" | "logout", action: () => Promise<ChatGPTStatus>) {
		if (operation.current) return;
		const intent = ++generation.current;
		operation.current = kind;
		setBusy(true); setError(null); setDismissedError(null);
		try {
			const value: unknown = await action();
			if (!mounted.current || intent !== generation.current) return;
			const next = publishStatus(value);
			if (!next) return; // Error-only IPC replies never replace safe status.
			if (kind === "logout" && !next.error && !next.accounts.find((a) => a.id === status.activeId && a.connected)) showDialog(null);
			else if (kind === "logout" && next.error === REVOCATION_WARNING) showDialog({ kind: "warning" });
			else setError(next.error);
		} catch { if (mounted.current && intent === generation.current) setError(CONTROL_ERROR); }
		finally { if (intent === generation.current) { operation.current = null; if (mounted.current) setBusy(false); } }
	}
	async function login() {
		const bridge = window.lh?.chatgpt;
		const owner = dialogRef.current;
		if (!bridge || operation.current || !status.available || status.pending || owner?.kind !== "connect") return;
		const attempt: LoginAttempt = { generation: ++generation.current, dialog: owner, registration, background, pending: false, phase: "starting" };
		loginAttempt.current = attempt; operation.current = "login";
		const request = ++statusSequence.current;
		setBusy(true); setError(null); setDismissedError(null);
		try {
			let value: unknown = await bridge.login(registration || undefined);
			if (!owns(attempt) || attempt.phase === "consent") return;
			// Never publish an old acknowledgement over a newer event. If events
			// coalesced past pending before the acknowledgement arrived, read the
			// current backend state after it rather than losing that completion.
			if (request !== statusSequence.current && isStatus(value)) {
				if (value.error) { setError(value.error); finish(attempt); return; }
				attempt.pending = true; attempt.phase = "pending";
				const refresh = ++statusSequence.current;
				value = await bridge.status();
				if (!owns(attempt) || loginAttempt.current?.phase === "consent" || refresh !== statusSequence.current) return;
			}
			const next = publishStatus(value);
			if (!next) { finish(attempt); return; }
			reconcile(next, true);
		} catch { if (owns(attempt)) { setError(CONTROL_ERROR); finish(attempt); } }
		// No finally: pending OAuth outlives this IPC promise. Only its status
		// completion, failure, or explicit cancellation releases the attempt.
	}
	const bridge = typeof window !== "undefined" ? window.lh?.chatgpt : undefined;
	const context = {
		status, busy, error: warning ? null : visibleError, inlineError: dialog || warning ? null : visibleError, warning: dialog?.kind === "warning" ? null : warning,
		connect: openConnect,
		manage: (id: string) => { if (!operation.current) { setError(null); showDialog({ kind: "manage", accountId: id }); } },
		select: (id: string) => { if (bridge) void control("change", () => bridge.select(id)); },
		dismissWarning: () => { setDismissedError(REVOCATION_WARNING); setError(null); },
	};
	return <Context.Provider value={context}>
		{children}
		{dialog && <AccountDialog onClose={close} busy={busy && operation.current !== "login"}>
			<h2 className="text-sm font-semibold text-foreground">{dialog.kind === "connect" ? "Continue with ChatGPT" : "ChatGPT account"}</h2>
			{dialog.kind === "warning" ? <>
				<p role="alert" className="mt-3 rounded-sm border border-border px-3 py-2 text-xs text-foreground" data-testid="chatgpt-revocation-warning">{REVOCATION_WARNING}</p>
				<div className="mt-4 flex justify-end"><Button variant="outline" size="sm" onClick={() => { context.dismissWarning(); showDialog(null); }}>Dismiss</Button></div>
			</> : <>
				{dialog.kind === "connect" && status.accounts.length > 0 && <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
					Saved ChatGPT account
					<select aria-label="Saved ChatGPT account" value={registration} onChange={(event) => setRegistration(event.target.value)} disabled={busy || status.pending} className="rounded-sm border border-border bg-background px-2 py-1.5 text-foreground">
						<option value="">Add another account or workspace</option>
						{status.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || "ChatGPT account"}</option>)}
					</select>
				</label>}
				{managed && <p className="mt-3 text-xs text-foreground">{managed.email || "ChatGPT account"}</p>}
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="chatgpt-privacy-notice">{CHATGPT_NOTICE}</p>
				<div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
					<a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer" className="underline underline-offset-2">OpenAI privacy</a>
					<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">Manage usage</a>
				</div>
				{(dialog.kind === "connect" || managed) && <div className="mt-4 flex items-start gap-3 text-xs text-foreground">
					<Toggle label="Allow background use" checked={dialog.kind === "connect" ? background : managed!.background} disabled={busy || status.pending || !status.available} onChange={(enabled) => {
						if (dialog.kind === "connect") setBackground(enabled);
						else if (managed && bridge) void control("change", () => bridge.consent(managed.id, enabled));
					}} />
					<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{CHATGPT_BACKGROUND_HINT}</span></span>
				</div>}
				{!status.available && <p className="mt-3 text-xs text-muted-foreground">ChatGPT sign-in is available only in the desktop app with secure OS credential storage. API-key connections remain available here.</p>}
				{status.pending && <p role="status" className="mt-3 text-xs text-muted-foreground">Waiting for browser sign-in…</p>}
				{context.error && <p role="alert" className="mt-3 text-xs text-red-400">{context.error}</p>}
				<div className="mt-4 flex items-center justify-end gap-2">
					<Button variant="ghost" size="sm" onClick={close} disabled={busy && operation.current !== "login"}>{dialog.kind === "connect" ? "Cancel" : "Close"}</Button>
					{dialog.kind === "connect" && <ContinueButton onClick={() => void login()} disabled={!status.available || busy || status.pending} testid="chatgpt-proceed" />}
					{managed && <Button variant="outline" size="sm" data-testid="chatgpt-disconnect" disabled={busy || status.pending} onClick={() => bridge && void control("logout", () => bridge.logout(managed.id))}>Disconnect</Button>}
				</div>
			</>}
		</AccountDialog>}
	</Context.Provider>;
}

function ContinueButton({ onClick, disabled, testid = "chatgpt-login" }: { onClick: () => void; disabled: boolean; testid?: string }) {
	return <Button type="button" variant="outline" size="sm" data-testid={testid} onClick={onClick} disabled={disabled} className="cursor-pointer disabled:cursor-not-allowed">
		{/* Official unmodified mark; existing secondary button hover/focus treatment. */}
		{/* eslint-disable-next-line @next/next/no-img-element */}
		<img src="/siwc/chatgpt-logo-white.svg" width="16" height="16" alt="" aria-hidden="true" />
		Continue with ChatGPT
	</Button>;
}

function AccountDialog({ children, onClose, busy }: { children: React.ReactNode; onClose: () => void; busy: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const backdropDismiss = useBackdropDismiss(onClose);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])') ?? [])];
		focusable()[0]?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
			} else if (event.key === "Tab") {
				const items = focusable(), first = items[0], last = items.at(-1);
				if (!first) { event.preventDefault(); return; }
				if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			}
		};
		// Capture claims the nested dialog's Escape before outer Settings/setup.
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80" data-testid="chatgpt-dialog-backdrop" {...backdropDismiss}>
		<div ref={ref} role="dialog" aria-modal="true" aria-label="ChatGPT account" aria-busy={busy} data-testid="chatgpt-account-dialog" onClick={(event) => event.stopPropagation()} className="settings-dialog-pop mx-4 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl">{children}</div>
	</div>, document.body);
}

/** Compact settings row, or setup's secondary action only. */
export function ChatGPTConnection({ setup = false }: { setup?: boolean }) {
	const ui = useContext(Context);
	const active = ui.status.accounts.find((a) => a.id === ui.status.activeId && a.connected);
	const accounts = ui.status.accounts.filter((a) => a.connected);
	return <div className="flex flex-col gap-2" data-testid="chatgpt-connection">
		<div className="flex flex-wrap items-center gap-3">
			{!setup && <span className="font-ui text-xs text-foreground">ChatGPT</span>}
			{active && !setup ? <>
				<select aria-label="ChatGPT account" value={active.id} disabled={ui.busy || ui.status.pending} onChange={(event) => ui.select(event.target.value)} className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground">
					{accounts.map((a) => <option key={a.id} value={a.id}>{a.email || "ChatGPT account"}</option>)}
				</select>
				<Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={() => ui.manage(active.id)}>Manage…</Button>
			</> : <ContinueButton onClick={ui.connect} disabled={!ui.status.available || ui.busy || ui.status.pending} />}
		</div>
		{ui.inlineError && <p role="alert" className="text-xs text-red-400">{ui.inlineError}</p>}
		{ui.warning && <div role="alert" data-testid="chatgpt-revocation-warning" className="rounded-sm border border-border px-3 py-2 text-xs text-muted-foreground">{ui.warning}<button type="button" className="ml-2 cursor-pointer underline underline-offset-2" onClick={ui.dismissWarning}>Dismiss</button></div>}
	</div>;
}

/** Contextual consent discovery belongs beside background model choices only. */
export function ChatGPTBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	const account: Account | undefined = ui.status.accounts.find((a) => a.id === ui.status.activeId && a.connected);
	if (provider !== "chatgpt" || !account || account.background) return null;
	return <Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={ui.busy} onClick={() => ui.manage(account.id)}>Enable background use</Button>;
}
