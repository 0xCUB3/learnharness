import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ChatGPTBackgroundAccess, ChatGPTConnection, ChatGPTUIProvider, CHATGPT_NOTICE } from "../components/settings/chatgpt-connection.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import type { ChatGPTStatus, ChatGPTControlBridge } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const account = (id = "private-registration-id", email = "learner@example.invalid", connected = true, background = false) => ({ id, email, registration: "private-issued-client", connected, background, planEnabled: true });
const disconnected = (): ChatGPTStatus => ({ available: true, pending: false, activeId: null, accounts: [account("signed-out-record", "signed-out@example.invalid", false)], error: null });
const connected = (background = false): ChatGPTStatus => ({ ...disconnected(), activeId: "private-registration-id", accounts: [account(undefined, undefined, true, background), ...disconnected().accounts] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(initial = disconnected(), overrides: Partial<ChatGPTControlBridge> = {}) {
 let status = initial;
 const calls = { login: 0, cancel: 0, consent: [] as boolean[], logout: 0 };
 const listeners = new Set<() => void>();
 const bridge: ChatGPTControlBridge = {
  status: async () => status,
  login: async () => { calls.login++; return status = connected(); },
  cancel: async () => { calls.cancel++; return status = disconnected(); },
  select: async (id) => { status = { ...status, activeId: id }; return status; },
  logout: async () => { calls.logout++; return status = disconnected(); },
  consent: async (id, enabled) => { calls.consent.push(enabled); status = { ...status, accounts: status.accounts.map((a) => a.id === id ? { ...a, background: enabled } : a) }; return status; },
  onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  ...overrides,
 };
 window.lh = { expandWindow() {}, chatgpt: bridge };
 return { calls, bridge, push(next: ChatGPTStatus) { status = next; for (const cb of listeners) cb(); } };
}
async function mount(children: React.ReactNode = <ChatGPTConnection />) {
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<ChatGPTUIProvider>{children}</ChatGPTUIProvider>));
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
function button(text: string, scope: ParentNode = document) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text)!; }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; globalThis.fetch = originalFetch; });

test("settings put Model providers first and select it by default", () => {
 const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
 assert.match(html, /settings-nav-keys[^>]*aria-current="true"/);
 assert(html.indexOf("settings-nav-keys") < html.indexOf("settings-nav-general"));
 assert.match(html, />Model providers<\/button>/);
 assert.doesNotMatch(html, />Connections<\/button>/);
});

test("setup and disconnected rows are secondary buttons, not disclosure walls; cancel never logs in or changes consent", async () => {
 const f = fixture(); await mount(<ChatGPTConnection setup />);
 assert(!document.body.textContent?.includes(CHATGPT_NOTICE));
 assert(!document.body.textContent?.includes("Manage usage"));
 assert(!document.body.textContent?.includes("signed-out@example.invalid"));
 assert.equal(f.calls.login, 0);
 const trigger = byTest("chatgpt-login");
 assert.match(trigger.className, /cursor-pointer/);
 assert.match(trigger.className, /hover:bg-accent/);
 assert.match(trigger.className, /focus-visible:ring/);
 await click(trigger);
 assert.equal(f.calls.login, 0, "opening disclosure is not OAuth");
 assert(document.body.textContent?.includes(CHATGPT_NOTICE));
 const toggle = document.querySelector<HTMLElement>('[role="switch"][aria-label="Allow background use"]')!;
 assert.equal(toggle.getAttribute("aria-checked"), "false");
 await click(toggle); assert.equal(toggle.getAttribute("aria-checked"), "true");
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert.equal(f.calls.login, 0); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
 await click(byTest("chatgpt-login"));
 assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false", "each initial connection choice starts OFF");
});

test("only explicit proceed invokes OAuth; initial background opt-in waits for verified connection", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login"));
 await click(document.querySelector<HTMLElement>('[role="switch"]')!);
 assert.deepEqual(f.calls.consent, []);
 await click(byTest("chatgpt-proceed"));
 assert.equal(f.calls.login, 1); assert.deepEqual(f.calls.consent, [true]);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert(button("Manage…"));
});

test("closing pending OAuth cancels and a late login result cannot apply draft consent", async () => {
 const login = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { login: () => { f.calls.login++; return login.promise; } });
 await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!);
 await click(byTest("chatgpt-proceed"));
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(f.calls.cancel, 1);
 await act(async () => login.resolve(connected()));
 assert.deepEqual(f.calls.consent, []);
 assert(!button("Manage…"));
});

test("connected account selector displays email only, excludes signed-out registrations, and retains safe fallback", async () => {
 const status = connected(); status.accounts.push(account("second-id", "second@example.invalid"), account("missing-email", ""));
 fixture(status); await mount();
 const select = document.querySelector<HTMLSelectElement>('select[aria-label="ChatGPT account"]')!;
 assert.deepEqual([...select.querySelectorAll("option")].map((o) => o.textContent), ["learner@example.invalid", "second@example.invalid", "ChatGPT account"]);
 assert.doesNotMatch(document.body.textContent!, /private-registration-id|private-issued-client|second-id|signed-out@example| · active|registration /);
 assert(!document.body.textContent?.includes(CHATGPT_NOTICE));
 await click(button("Manage…"));
 assert(document.body.textContent?.includes(CHATGPT_NOTICE));
 assert(byTest("chatgpt-disconnect"));
});

test("successful local disconnect removes action, resets dialog, and prevents repeated pending clicks without deleting registration UI state", async () => {
 const logout = deferred<ChatGPTStatus>();
 const f = fixture(connected(), { logout: () => { f.calls.logout++; return logout.promise; } });
 await mount(); await click(button("Manage…"));
 const disconnect = byTest("chatgpt-disconnect") as HTMLButtonElement;
 await act(async () => { disconnect.click(); disconnect.click(); });
 assert.equal(f.calls.logout, 1); assert.equal(disconnect.disabled, true);
 await act(async () => logout.resolve(disconnected()));
 assert(!document.querySelector('[data-testid="chatgpt-disconnect"]'));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert(byTest("chatgpt-login"));
 assert(!document.body.textContent?.includes("Signed out locally"));
 assert(!document.querySelector('[role="alert"]'));
 await click(byTest("chatgpt-login"));
 assert(document.body.textContent?.includes("signed-out@example.invalid"), "retained registration can still be explicitly reauthorized inside sign-in dialog");
});

test("real unconfirmed revoke is a distinct contextual dismissible warning, not permanent global red error", async () => {
 const warning = "Signed out locally. Remote revocation was not confirmed; disconnect LearnHarness in ChatGPT Settings.";
 fixture(connected(), { logout: async () => ({ ...disconnected(), error: warning }) });
 await mount(); await click(button("Manage…")); await click(byTest("chatgpt-disconnect"));
 assert(byTest("chatgpt-login")); assert(!document.querySelector('[data-testid="chatgpt-disconnect"]'));
 const alert = byTest("chatgpt-revocation-warning");
 assert.equal(alert.textContent, warning); assert.doesNotMatch(alert.className, /text-red/);
 await click(button("Dismiss", byTest("chatgpt-account-dialog")));
 assert(!document.querySelector('[data-testid="chatgpt-revocation-warning"]'));
 assert(!document.querySelector('[role="alert"]'));
});

test("background model choice has contextual Enable action only while connected, selected, and consent OFF", async () => {
 const f = fixture(connected());
 await mount(<><ChatGPTBackgroundAccess provider="chatgpt" /><ChatGPTBackgroundAccess provider="openai" /><ChatGPTConnection /></>);
 assert.equal([...document.querySelectorAll("button")].filter((b) => b.textContent === "Enable background use").length, 1);
 await click(button("Enable background use"));
 assert.deepEqual(f.calls.consent, []);
 await click(document.querySelector<HTMLElement>('[role="switch"]')!);
 assert.deepEqual(f.calls.consent, [true]);
 assert(!button("Enable background use"));
 await act(async () => f.push(disconnected()));
 assert(!button("Enable background use"));
});

test("browser-only sign-in is disabled without invoking OAuth", async () => {
 await mount();
 const trigger = byTest("chatgpt-login") as HTMLButtonElement;
 assert(trigger.disabled); assert.match(trigger.className, /disabled:opacity/);
 await click(trigger); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("foreground model/dictation toolbar has no plan badge or background-consent action", async () => {
 globalThis.fetch = async (input) => {
  if (input === "/api/models") return Response.json({ models: [], providers: [], slots: {}, defaults: {} });
  if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model: { provider: "chatgpt", id: "gpt-5" } } } } });
  throw new Error(`unexpected fixture request ${input}`);
 };
 fixture(connected()); await mount(<ModelControl />);
 assert.match(byTest("stats-model").textContent!, /gpt/i);
 assert(!document.body.textContent?.includes("Using ChatGPT plan"));
 assert(!document.body.textContent?.includes("Enable background use"));
 assert(!document.querySelector('a[href="https://chatgpt.com/settings/usage"]'));
});
