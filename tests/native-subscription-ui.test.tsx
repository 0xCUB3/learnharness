import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NativeSubscriptionBackgroundAccess, NativeSubscriptionConnection, NativeSubscriptionsUIProvider } from "../components/settings/subscription-connections.tsx";
import type { NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const CLAUDE: NativeSubscriptionProviderId = "subscription-anthropic";
let root: Root | undefined, host: HTMLDivElement | undefined;
const acct = (id: string, label: string, connected = true) => ({ id, label, connected });
const base = (over: Partial<NativeSubscriptionStatus> = {}): NativeSubscriptionStatus => ({ available: true, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null, ...over });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(initial = base(), over: Partial<NativeSubscriptionControlBridge> = {}) {
 let status = initial;
 const calls = { login: [] as (string | undefined)[], loginBg: [] as (boolean | undefined)[], cancel: 0, consent: [] as boolean[], disconnect: [] as string[], select: [] as string[], providers: new Set<string>() };
 const listeners = new Set<() => void>();
 const push = (next: NativeSubscriptionStatus) => { status = next; for (const cb of listeners) cb(); };
 const bridge: NativeSubscriptionControlBridge = {
  status: async (p) => { calls.providers.add(p); return p === CLAUDE ? status : base(); },
  login: async (_p, id, bg?: boolean) => { calls.login.push(id); calls.loginBg.push(bg); push({ ...status, pending: true }); return status; },
  cancel: async () => { calls.cancel++; push({ ...status, pending: false }); return status; },
  select: async (_p, id) => { calls.select.push(id); push({ ...status, activeId: id }); return status; },
  disconnect: async (_p, id) => { calls.disconnect.push(id); push({ ...status, activeId: status.activeId === id ? null : status.activeId, accounts: status.accounts.filter((a) => a.id !== id) }); return status; },
  logout: async () => status,
  consent: async (_p, enabled) => { calls.consent.push(enabled); push({ ...status, allowBackgroundUse: enabled }); return status; },
  onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, ...over,
 };
 window.lh = { expandWindow() {}, subscriptions: bridge };
 return { calls, push, get status() { return status; } };
}
async function mount(children: React.ReactNode = <NativeSubscriptionConnection provider={CLAUDE} />) {
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<NativeSubscriptionsUIProvider>{children}</NativeSubscriptionsUIProvider>));
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function click(el: HTMLElement) { assert(el); await act(async () => el.click()); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; });

test("Continue shows disclosure before login, then completes with background consent", async () => {
 const f = fixture(); await mount();
 assert.equal(byTest("native-claude-login").textContent, "Continue with Claude");
 await click(byTest("native-claude-login"));
 assert.equal(f.calls.login.length, 0);
 assert.match(byTest("native-claude-privacy-notice").textContent!, /Anthropic does not permit third-party Claude\.ai login\..*unencrypted private file.*sent directly to Anthropic/);
 assert(!document.querySelector("textarea, input[type=text]"));
 await click(document.querySelector('[data-testid="native-claude-global-background"] [role="switch"]')!);
 await click(byTest("native-claude-proceed"));
 assert.deepEqual(f.calls.login, [undefined]);
 await act(async () => f.push(base({ activeId: "a1", accounts: [acct("a1", "Work")] })));
 assert.deepEqual(f.calls.consent, [false]);
 assert(!byTest("native-claude-account-dialog"));
 assert.equal(byTest("native-claude-account").textContent, "Work");
 assert(!document.body.textContent!.includes("a1"));
});

test("cancel and unmount ignore stale results", async () => {
 const f = fixture(); await mount();
 await click(byTest("native-claude-login")); await click(byTest("native-claude-proceed"));
 await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
 assert.equal(f.calls.cancel, 1);
 await act(async () => f.push(base({ activeId: "late", accounts: [acct("late", "Late")] })));
 assert(!byTest("native-claude-account-dialog"));
});

test("stale login acknowledgement after unmount does nothing", async () => {
 const gate = deferred<NativeSubscriptionStatus>();
 const f = fixture(base(), { login: () => gate.promise }); await mount();
 await click(byTest("native-claude-login")); await click(byTest("native-claude-proceed"));
 await act(async () => root!.unmount()); root = undefined;
 await act(async () => gate.resolve(base({ pending: true })));
 assert.equal(f.calls.cancel, 0);
});

test("disconnect needs confirmation and warns about local revocation", async () => {
 const f = fixture(base({ activeId: "a1", accounts: [acct("a1", "Work")] }), {});
 await mount();
 await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Manage…")!);
 await click(byTest("native-claude-disconnect"));
 assert.equal(f.calls.disconnect.length, 0);
 assert.match(byTest("native-claude-disconnect-confirmation").textContent!, /may not be notified/);
 await click(byTest("native-claude-confirm-disconnect"));
 assert.deepEqual(f.calls.disconnect, ["a1"]);
 assert(!byTest("native-claude-account-dialog"));
});

test("multiple accounts use a selector and select by id", async () => {
 const f = fixture(base({ activeId: "a1", accounts: [acct("a1", "One"), acct("a2", "Two")] }));
 await mount();
 const select = document.querySelector<HTMLSelectElement>('select[aria-label="Claude account"]')!;
 assert.equal(select.querySelectorAll("option").length, 2);
 await act(async () => { Object.defineProperty(select, "value", { configurable: true, writable: true, value: "a2" }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
 assert.deepEqual(f.calls.select, ["a2"]);
});

test("background save failure is visible and keeps the dialog open", async () => {
 const f = fixture(base({ activeId: "a1", accounts: [acct("a1", "Work")] }), { consent: async () => base({ activeId: "a1", accounts: [acct("a1", "Work")], error: "raw provider detail" }) });
 await mount();
 await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Manage…")!);
 await click(document.querySelector('[data-testid="native-claude-global-background"] [role="switch"]')!);
 const alert = document.querySelector('[role="alert"]')!;
 assert(alert); assert(!document.body.textContent!.includes("raw provider detail"));
 assert(byTest("native-claude-account-dialog")); assert(f.calls.providers.size > 0);
});

test("absent bridge disables Continue with a hint and background access maps providers only", async () => {
 await mount(<><NativeSubscriptionConnection provider="subscription-xai" /><NativeSubscriptionBackgroundAccess provider="chatgpt" /></>);
 assert(byTest("native-grok-login").hasAttribute("disabled"));
 assert.match(byTest("native-grok-hint").textContent!, /desktop app/);
 assert(!document.querySelector('[role="alert"]'));
});

test("no HTTP auth routes", async () => {
 const calls: unknown[] = []; const orig = globalThis.fetch; globalThis.fetch = (async (...a: unknown[]) => { calls.push(a); return new Response("{}"); }) as typeof fetch;
 try { fixture(); await mount(); await click(byTest("native-claude-login")); await click(byTest("native-claude-proceed")); } finally { globalThis.fetch = orig; }
 assert.deepEqual(calls, []);
});

test("background access shows only when active and consent is off", async () => {
 fixture(base({ activeId: "a1", accounts: [acct("a1", "Work")], allowBackgroundUse: false }));
 await mount(<NativeSubscriptionBackgroundAccess provider={CLAUDE} />);
 assert.equal(host!.textContent, "Enable background use");
});

test("legacy Codex pin resolves the upstream ChatGPT catalog entry in setup prefill", async () => {
 const { prefillFromSlots } = await import("../components/setup-dialog.tsx");
 const entry = { provider: "chatgpt", id: "gpt-x", input: ["text"], supportedLevels: [] } as never;
 const pre = prefillFromSlots([entry], { strong: { model: { provider: "subscription-openai-codex", id: "gpt-x" } } } as never);
 assert.equal(pre.strong, entry);
});

test("storage error is visible and suggests checking local file access, without raw text", async () => {
 const storage = "Claude credentials could not be read or saved. Check local file access, then reconnect before making requests.";
 fixture(base({ error: storage + " /Users/x/secret.json" })); await mount();
 const text = document.body.textContent!;
 assert.match(text, /Check local file access/);
 assert(!text.includes("secret.json"));
});

test("browser-open and timeout failures show fixed helpful text", async () => {
 const f = fixture(); await mount();
 await click(byTest("native-claude-login")); await click(byTest("native-claude-proceed"));
 await act(async () => f.push(base({ error: "Claude sign-in could not open your browser. Try again." })));
 assert.match(byTest("native-claude-account-dialog").textContent!, /Check your default browser/);
});

test("login receives the unchecked background choice atomically", async () => {
 const f = fixture(); await mount();
 await click(byTest("native-claude-login"));
 await click(document.querySelector('[data-testid="native-claude-global-background"] [role="switch"]')!);
 await click(byTest("native-claude-proceed"));
 assert.deepEqual(f.calls.loginBg, [false]);
});

test("timeout message tells the user to start sign-in again", async () => {
 const f = fixture(); await mount();
 await click(byTest("native-claude-login")); await click(byTest("native-claude-proceed"));
 await act(async () => f.push(base({ error: "Claude sign-in timed out. Finish sign-in in the browser that opened, then try again." })));
 assert.match(byTest("native-claude-account-dialog").textContent!, /Sign-in timed out\. Start sign-in again\./);
});

test("after disconnecting the active account a saved one can be selected without login", async () => {
 const f = fixture(base({ activeId: "a1", accounts: [acct("a1", "One"), acct("a2", "Two")] })); await mount();
 await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Manage…")!);
 await click(byTest("native-claude-disconnect")); await click(byTest("native-claude-confirm-disconnect"));
 assert.equal(f.status.activeId, null);
 const select = document.querySelector<HTMLSelectElement>('select[aria-label="Claude account"]')!; assert(select);
 assert.match(select.textContent!, /Choose a Claude account/);
 await act(async () => { Object.defineProperty(select, "value", { configurable: true, writable: true, value: "a2" }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
 assert.deepEqual(f.calls.select, ["a2"]); assert.deepEqual(f.calls.login, []);
});
