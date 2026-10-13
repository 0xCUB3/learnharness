"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { messageAnchorId, messageIdFromHash, type LhViewMessage } from "@/src/core";

export type SessionScrollContext = Pick<StickToBottomContext, "scrollRef" | "stopScroll">;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Scroll only the session's own containers (including tall question/code
 * areas), never sidebar/chrome. Inner containers move first, then the main
 * transcript. stopScroll releases the sticky-bottom animation BEFORE jumping. */
export function scrollSessionTarget(target: Range | HTMLElement, scope: HTMLElement, context: SessionScrollContext | null): void {
	const node = "startContainer" in target ? target.startContainer : target;
	const main = context?.scrollRef.current;
	if (main?.contains(node)) context!.stopScroll();
	for (let element = node.parentElement; element && scope.contains(element); element = element.parentElement) {
		const view = element.ownerDocument.defaultView;
		const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
		if (element !== main && (!style || !/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight)) continue;
		const rect = target.getBoundingClientRect();
		const container = element.getBoundingClientRect();
		element.scrollTo({ top: element.scrollTop + rect.top - container.top - 16, behavior: "instant" });
	}
}

/** React owns message markup; this controller adds no messages or content.
 * Native hash/back-forward navigation retries after the view arrives, and
 * subsequent streaming updates must NOT repeat the source jump. */
export function SessionMessageNavigation({ messages }: { messages: readonly LhViewMessage[] }) {
	const context = useStickToBottomContext();
	const { scrollRef, stopScroll } = context;
	const lastJump = useRef<{ hash: string; target: HTMLElement } | null>(null);
	const frame = useRef<number | null>(null);
	const flash = useRef<{ target: HTMLElement; timer: number } | null>(null);
	const clearFlash = useCallback(() => {
		if (!flash.current) return;
		window.clearTimeout(flash.current.timer);
		flash.current.target.classList.remove("lh-source-highlight");
		flash.current = null;
	}, []);
	const jump = useCallback(() => {
		const hash = window.location.hash;
		const messageId = messageIdFromHash(hash);
		const main = scrollRef.current;
		const target = messageId ? document.getElementById(messageAnchorId(messageId)) : null;
		if (!main || !target || !main.contains(target)) return;
		if (lastJump.current?.hash === hash && lastJump.current.target === target) return;
		stopScroll();
		if (frame.current !== null) window.cancelAnimationFrame(frame.current);
		// Dock height and the initial ResizeObserver settle before the jump.
		// A second stop cancels any initial bottom-follow queued in that frame.
		frame.current = window.requestAnimationFrame(() => {
			frame.current = null;
			if (!target.isConnected || window.location.hash !== hash) return;
			stopScroll();
			scrollSessionTarget(target, main, { scrollRef, stopScroll });
			clearFlash();
			target.classList.add("lh-source-highlight");
			flash.current = { target, timer: window.setTimeout(clearFlash, 2_000) };
			lastJump.current = { hash, target };
		});
	}, [scrollRef, stopScroll, clearFlash]);

	useIsoLayoutEffect(() => { jump(); }, [jump, messages]);
	useEffect(() => {
		const onHash = () => {
			lastJump.current = null;
			clearFlash();
			jump();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
			if (frame.current !== null) window.cancelAnimationFrame(frame.current);
			frame.current = null;
			lastJump.current = null;
			clearFlash();
		};
	}, [jump, clearFlash]);
	return null;
}
