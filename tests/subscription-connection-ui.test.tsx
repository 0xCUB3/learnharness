import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NativeSubscriptionConnection, NativeSubscriptionUIProvider, SubscriptionConnections, COPILOT_POLICY_NOTICE, emptySubscriptionStatus } from "../components/settings/subscription-connections.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import type { NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "../src/core/contracts/subscriptions.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(connected = false) {
	let statuses: NativeSubscriptionStatus[] = ["github-copilot", "xai"].map((id) => ({ ...emptySubscriptionStatus(id as NativeSubscriptionProviderId), available: true, connected, connectionId: connected ? `local-${id}` : null }));
	const listeners = new Set<() => void>(), login = deferred();
	const calls = { login: [] as unknown[][], cancel: 0, open: [] as unknown[][], consent: [] as unknown[][], disconnect: [] as string[] };
	function push(id: NativeSubscriptionProviderId, next: Partial<NativeSubscriptionStatus>) {
		statuses = statuses.map((s) => s.providerId === id ? { ...s, revision: s.revision + 1, ...next } : s); for (const listener of listeners) listener();
	}
	const bridge: NativeSubscriptionControlBridge = {
		status: async () => structuredClone(statuses),
		login: async (id, enabled) => { calls.login.push([id, enabled]); push(id, { pending: true, interaction: { attemptId: "attempt", userCode: "PUBLIC-CODE", browser: { id: "opaque-action", url: "https://auth.example/device" }, progress: "Complete sign-in in your browser." } }); await login.promise; },
		cancel: async (id) => { calls.cancel++; push(id, { pending: false, interaction: undefined }); },
		respond: async () => {}, open: async (...args) => { calls.open.push(args); }, retry: async () => {},
		disconnect: async (id) => { calls.disconnect.push(id); push(id, { connected: false, connectionId: null }); },
		consent: async (id, enabled) => { calls.consent.push([id, enabled]); push(id, { allowBackgroundUse: enabled }); },
		onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	window.lh = { expandWindow() {}, subscriptions: bridge };
	return { bridge, calls, login, push, get statuses() { return statuses; } };
}
async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<NativeSubscriptionUIProvider><NativeSubscriptionConnection providerId="github-copilot" /><NativeSubscriptionConnection providerId="xai" /></NativeSubscriptionUIProvider>));
}
function button(text: string, scope: ParentNode = document) { const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text); assert(found, `missing button ${text}`); return found; }
const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}-connection"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[data-testid="subscription-connection-dialog"]')!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; });

test("three compact rows render in approved order with no browser-only sign-in or fabricated identities", () => {
	const html = renderToStaticMarkup(<ChatGPTUIProvider><NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider></ChatGPTUIProvider>);
	assert(html.indexOf('data-testid="chatgpt-connection"') < html.indexOf('data-testid="github-copilot-connection"'));
	assert(html.indexOf('data-testid="github-copilot-connection"') < html.indexOf('data-testid="xai-connection"'));
	assert.equal((html.match(/>Connect<\/button>/g) ?? []).length, 3);
	assert(!html.includes("@")); assert(!html.includes("Add accounts"));
});
test("Copilot disclosure and default-ON draft appear before login; browser action passes only opaque IDs", async () => {
	const f = fixture(); await mount(); await click(button("Connect", row("github-copilot")));
	assert(dialog().textContent?.includes(COPILOT_POLICY_NOTICE)); assert.equal(f.calls.login.length, 0);
	const toggle = dialog().querySelector<HTMLElement>('[role="switch"]')!; assert.equal(toggle.getAttribute("aria-checked"), "true");
	await click(toggle); await click(button("Connect", dialog())); assert.deepEqual(f.calls.login, [["github-copilot", false]]);
	assert(dialog().textContent?.includes("PUBLIC-CODE")); await click(button("Open browser", dialog()));
	assert.deepEqual(f.calls.open, [["github-copilot", "attempt", "opaque-action"]]);
	await click(button("Cancel", dialog())); assert.equal(f.calls.cancel, 1); assert(!dialog());
	await click(button("Connect", row("xai"))); const newer = dialog(); await act(async () => f.login.resolve());
	assert(dialog() === newer, "old completion cannot close another provider dialog");
});
test("single native connection management has no account controls; background changes are independent and disconnect is confirmed", async () => {
	const f = fixture(true); await mount(); await click(button("Manage…", row("xai")));
	assert(!dialog().querySelector("select")); assert(!dialog().textContent?.includes("Add accounts")); assert(button("Reconnect", dialog()));
	await click(dialog().querySelector<HTMLElement>('[role="switch"]')!); assert.deepEqual(f.calls.consent, [["xai", false]]);
	assert.equal(f.statuses.find((s) => s.providerId === "github-copilot")!.allowBackgroundUse, true);
	await click(button("Disconnect", dialog())); assert.equal(f.calls.disconnect.length, 0);
	assert(dialog().textContent?.includes("does not cancel your subscription or revoke access"));
	await click(button("Cancel", dialog())); assert(button("Reconnect", dialog()));
	await click(button("Disconnect", dialog())); await click(button("Disconnect", dialog())); assert.deepEqual(f.calls.disconnect, ["xai"]); assert(!dialog());
});
test("required native prompts render and commit cannot be cancelled through button, Escape or backdrop", async () => {
	const f = fixture(); await mount(); await click(button("Connect", row("github-copilot"))); await click(button("Connect", dialog()));
	await act(async () => f.push("github-copilot", { interaction: { attemptId: "attempt", prompt: { id: "enterprise", type: "text", message: "Enterprise domain (leave blank for github.com)", placeholder: "company.ghe.com" } } }));
	assert.equal(dialog().querySelector("input")?.getAttribute("placeholder"), "company.ghe.com"); assert(button("Continue", dialog()));
	await act(async () => f.push("github-copilot", { committing: true, interaction: undefined }));
	assert(button("Cancel", dialog()).disabled); await click(button("Cancel", dialog())); assert.equal(f.calls.cancel, 0); assert(dialog());
	await act(async () => { const event = new window.Event("keydown", { bubbles: true }); Object.defineProperty(event, "key", { value: "Escape" }); document.dispatchEvent(event); });
	assert(dialog()); assert.equal(f.calls.cancel, 0);
	await act(async () => f.login.resolve());
});
