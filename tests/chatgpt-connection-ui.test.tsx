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
 const calls = { login: 0, cancel: 0, consent: [] as boolean[], consentIds: [] as string[], logout: 0 };
 const listeners = new Set<() => void>();
 const bridge: ChatGPTControlBridge = {
  status: async () => status,
  login: async () => { calls.login++; return status = connected(); },
  cancel: async () => { calls.cancel++; return status = disconnected(); },
  select: async (id) => { status = { ...status, activeId: id }; return status; },
  logout: async () => { calls.logout++; return status = disconnected(); },
  consent: async (id, enabled) => { calls.consentIds.push(id); calls.consent.push(enabled); status = { ...status, accounts: status.accounts.map((a) => a.id === id ? { ...a, background: enabled } : a) }; return status; },
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

const storageError = "ChatGPT credentials could not be saved securely. Reconnect before making requests.";
const errorReply = () => ({ error: storageError } as ChatGPTStatus); // Actual IPC catch envelope, deliberately not a snapshot.
function pendingFixture(initial = disconnected(), overrides: Partial<ChatGPTControlBridge> = {}) {
 const f = fixture(initial, { login: async () => { f.calls.login++; const pending = { ...initial, pending: true }; f.push(pending); return pending; }, ...overrides });
 return f;
}

test("production lifecycle: Cancel after the immediate pending reply cancels OAuth; later events cannot apply the old choice or close a new dialog", async () => {
 const f = pendingFixture(); await mount(); await click(byTest("chatgpt-login"));
 await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 assert(document.body.textContent?.includes("Waiting for browser sign-in"));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 1);
 await click(byTest("chatgpt-login")); const nextDialog = byTest("chatgpt-account-dialog");
 await act(async () => f.push(connected(false)));
 assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.login, 1); assert.equal(byTest("chatgpt-account-dialog"), nextDialog);
});

test("production lifecycle: verified onChange applies explicit ON once to the completed account and closes only its disclosure", async () => {
 const f = pendingFixture(); await mount(); await click(byTest("chatgpt-login"));
 await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 assert.equal(f.calls.login, 1); assert.deepEqual(f.calls.consent, []);
 assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled);
 await act(async () => f.push(connected(false)));
 assert.deepEqual(f.calls.consent, [true]); assert.deepEqual(f.calls.consentIds, ["private-registration-id"]);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => f.push(connected(true))); assert.deepEqual(f.calls.consent, [true]);
});

test("production lifecycle: initial OFF revokes retained ON only after verified returning-account completion", async () => {
 const initial = connected(true); initial.activeId = null; initial.accounts[0]!.connected = false;
 const f = pendingFixture(initial); await mount(); await click(byTest("chatgpt-login"));
 assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
 await click(byTest("chatgpt-proceed")); assert.deepEqual(f.calls.consent, []);
 await act(async () => f.push(connected(true)));
 assert.deepEqual(f.calls.consent, [false]); assert.deepEqual(f.calls.consentIds, ["private-registration-id"]);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("error-only logout reply preserves valid status, shows recoverable error, never claims disconnect, and permits explicit retry", async () => {
 const f = fixture(connected(), { logout: async () => { f.calls.logout++; return errorReply(); } });
 await mount(); await click(button("Manage…"));
 await assert.doesNotReject(() => click(byTest("chatgpt-disconnect")));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((byTest("chatgpt-disconnect") as HTMLButtonElement).disabled, false);
 assert.equal(document.querySelector('select[aria-label="ChatGPT account"] option')?.textContent, "learner@example.invalid");
 assert(!document.querySelector('[data-testid="chatgpt-login"]')); assert(!document.body.textContent?.includes("Signed out locally"));
 f.bridge.logout = async () => { f.calls.logout++; return disconnected(); };
 await click(byTest("chatgpt-disconnect")); assert.equal(f.calls.logout, 2);
 assert(byTest("chatgpt-login")); assert(!document.querySelector('[data-testid="chatgpt-disconnect"]'));
});

test("error-only consent reply leaves the saved toggle unchanged with a contextual error", async () => {
 fixture(connected(), { consent: async () => errorReply() }); await mount(); await click(button("Manage…"));
 await assert.doesNotReject(() => click(document.querySelector<HTMLElement>('[role="switch"]')!));
 assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-disconnect"));
});

test("error-only initial login reply is recoverable without corrupting status or automatically retrying", async () => {
 const f = fixture(disconnected(), { login: async () => { f.calls.login++; return errorReply(); } });
 await mount(); await click(byTest("chatgpt-login")); await assert.doesNotReject(() => click(byTest("chatgpt-proceed")));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, false); assert.equal(f.calls.login, 1);
 assert.deepEqual(f.calls.consent, []);
});

test("error-only consent after verified login keeps disclosure/error open and cannot be retried by a duplicate completion push", async () => {
 let consentCalls = 0;
 const f = pendingFixture(disconnected(), { consent: async () => { consentCalls++; return errorReply(); } });
 await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push(connected(false)));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-account-dialog"));
 await act(async () => f.push(connected(false))); assert.equal(consentCalls, 1); assert.equal(f.calls.login, 1);
});

test("failed pending attempt never applies draft consent, starts another login, or closes disclosure on a later clean status", async () => {
 const f = pendingFixture(); await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push({ ...connected(false), error: "ChatGPT sign-in could not be verified." }));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, "ChatGPT sign-in could not be verified.");
 await act(async () => f.push(connected(false)));
 assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.login, 1); assert(byTest("chatgpt-account-dialog"));
});

test("saved-registration attempt cannot apply its choice to a different active account", async () => {
 const f = pendingFixture(); await mount(); await click(byTest("chatgpt-login"));
 const select = document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')!;
 await act(async () => { select.querySelector<HTMLOptionElement>('option[value="signed-out-record"]')!.selected = true; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
 await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push(connected(false)));
 assert.deepEqual(f.calls.consent, []); assert(byTest("chatgpt-account-dialog")); assert(document.querySelector('[role="alert"]'));
});

test("account invalidation while initial consent is awaiting IPC fences its stale reply and preserves an unrelated later Manage dialog", async () => {
 const consent = deferred<ChatGPTStatus>();
 const f = pendingFixture(disconnected(), { consent: () => consent.promise });
 await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push(connected(false)));
 const other = { ...connected(), activeId: "other", accounts: [account("other", "other@example.invalid")] };
 await act(async () => f.push(other));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); await click(button("Manage…")); const manage = byTest("chatgpt-account-dialog");
 await act(async () => consent.resolve(connected(true)));
 assert.equal(byTest("chatgpt-account-dialog"), manage); assert(manage.textContent?.includes("other@example.invalid"));
 assert.equal(document.querySelector('select[aria-label="ChatGPT account"] option')?.textContent, "other@example.invalid");
});

test("verified event before the initial IPC acknowledgement is handled once; the late pending reply cannot reopen or overwrite it", async () => {
 const ack = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { login: () => { f.calls.login++; return ack.promise; } });
 await mount(); await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push({ ...disconnected(), pending: true }));
 await act(async () => f.push(connected(false)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => ack.resolve({ ...disconnected(), pending: true }));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(button("Manage…")); assert.equal(f.calls.login, 1);
});

test("error-only pending cancellation reply remains visible and recoverable without replacing status", async () => {
 const f = pendingFixture(disconnected(), { cancel: async () => { f.calls.cancel++; return errorReply(); } });
 await mount(); await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed"));
 await assert.doesNotReject(() => click(button("Cancel", byTest("chatgpt-account-dialog"))));
 assert.equal(f.calls.cancel, 1); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert(document.querySelector('[data-testid="chatgpt-connection"]')); assert.deepEqual(f.calls.consent, []);
 assert(byTest("chatgpt-account-dialog"));
 f.bridge.cancel = async () => { f.calls.cancel++; return disconnected(); };
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(f.calls.cancel, 2); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("coalesced completion before the pending acknowledgement is reconciled from fresh post-ack status", async () => {
 const ack = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { login: () => { f.calls.login++; return ack.promise; } });
 await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 // A status reader can miss pending entirely when two notifications coalesce.
 await act(async () => f.push(connected(false))); assert.deepEqual(f.calls.consent, []);
 await act(async () => ack.resolve({ ...disconnected(), pending: true }));
 assert.deepEqual(f.calls.consent, [true]); assert.deepEqual(f.calls.consentIds, ["private-registration-id"]);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("a canceled attempt's late IPC reply cannot release a newer pending attempt or apply its old ON choice", async () => {
 const oldAck = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { login: async () => {
  f.calls.login++;
  if (f.calls.login === 1) return oldAck.promise;
  const pending = { ...disconnected(), pending: true }; f.push(pending); return pending;
 } });
 await mount(); await click(byTest("chatgpt-login")); await click(document.querySelector<HTMLElement>('[role="switch"]')!); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push({ ...disconnected(), pending: true })); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed"));
 await act(async () => oldAck.resolve(connected(false)));
 assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled); assert.deepEqual(f.calls.consent, []);
 const next = { ...connected(), activeId: "new-attempt-account", accounts: [account("new-attempt-account", "new@example.invalid", true, true)] };
 await act(async () => f.push(next));
 assert.deepEqual(f.calls.consent, [false]); assert.deepEqual(f.calls.consentIds, ["new-attempt-account"]);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert.equal(f.calls.login, 2);
});
