"use client";

/**
 * ENTER SUBMITS — regardless of where focus is (owner round 6, 2026-10-05).
 * The dictation reality: the learner dictates into the dock's field without
 * ever focusing it, so Enter must submit from ANYWHERE — body focus, a
 * scroll, a stray link. The field's own Enter handler still fires first
 * when it IS focused (this listener sits at the window level, bubble's last
 * stop) — one law, two entry points, no double submit (the focused field's
 * handler claims the event via its own keydown; this hook skips typing
 * surfaces entirely).
 *
 * What the window listener refuses to touch:
 * - typing surfaces (input/textarea/select/contenteditable) — the focused
 *   surface owns its Enter (the dock field, the composer, settings);
 * - BUTTONS — Enter on a focused button is its click (keyboard button
 *   semantics: the collapsed Problem bar must expand, not submit);
 * - modified Enter (⇧↵ is a newline, ⌘/Ctrl↵ belongs to the surface).
 *
 * The submit callbacks self-guard (empty thinking / canSubmit) — this hook
 * never checks answer validity, only focus honesty.
 */

import { useEffect, useRef } from "react";
import { isTypingSurface } from "@/src/core";

/** Mount-scoped: while the dock is mounted (a problem/question is active),
 *  plain Enter anywhere outside a typing surface or button submits it. */
export function useEnterSubmits(submit: () => void): void {
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
