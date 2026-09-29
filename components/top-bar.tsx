"use client";

/**
 * THE TOP BAR (owner standardization ruling, 2026-09-29): one element,
 * every surface — the same mechanics ALWAYS. Born from the chains-overlay
 * incident: its hand-rolled bar broke every rule at once (wrong height,
 * wrong title size, whole-bar no-drag so window drags fell through to
 * text selection, no sidebar reopen, traffic lights over content). The
 * law: whenever a surface has a top bar, it renders THIS component —
 * never a bespoke header.
 *
 * Mechanics baked in (the chat-session bar's proven pattern):
 * - h-15 (60px) — matches the sidebar's wordmark band, one border line.
 * - lh-drag — the window-drag band; interactive children carve out with
 *   lh-no-drag (the mask law: carve-outs must come later in the DOM).
 * - select-none — dragging never highlights the title.
 * - SidebarToggle FIRST — the sidebar reopen when closed, with its
 *   Electron traffic-light gutter (lh-closed-toggle).
 * - border-b border-border px-3, gap-3 rhythm.
 *
 * The consumer brings the title (font-title text-3xl tracking-tight) and
 * any right-side controls (lh-no-drag on each). `drag={false}` is the one
 * escape hatch — chat's rename mode (app-region:drag would eat the
 * mousedown that exits the input; owner ask).
 */

import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar";

export function TopBar({
	drag = true,
	onMouseDown,
	children,
}: {
	drag?: boolean;
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
}) {
	return (
		<header
			onMouseDown={onMouseDown}
			className={`${drag ? "lh-drag " : ""}flex h-15 select-none items-center gap-3 border-b border-border px-3`}
		>
			<SidebarToggle />
			{children}
		</header>
	);
}
