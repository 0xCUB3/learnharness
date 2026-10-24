"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is a class on <html> ("dark" default,
 * "light"): app/layout.tsx seeds it (and the vars) server-side from the saved
 * record so a light boot never flashes dark, this provider keeps it in sync,
 * and the desktop shell is told the mode + effective background over the
 * narrow window.lh.setTheme bridge.
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { effectiveBackground, resolveAppearance, appearanceVars, staleVarNames, type AppearanceSettings } from "@/src/core";

export {
	DARK_BACKGROUND,
	LIGHT_BACKGROUND,
	appearanceVars,
	derivedPalette,
	effectiveBackground,
	resolveAppearance,
	staleVarNames,
} from "@/src/core";

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initial,
}: {
	children: React.ReactNode;
	/** The saved appearance read server-side (app/layout.tsx), so first paint
	 *  already matches it. */
	initial?: AppearanceSettings;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initial);
	const appliedRef = useRef<string>("");

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta)), [delta]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// The mode: one class on <html> (layout seeds it; this keeps it live) and
	// the desktop shell's native background/titlebar, told through the narrow
	// bridge (absent in a plain browser).
	const resolvedNow = useMemo(() => resolveAppearance(delta), [delta]);
	const mode = resolvedNow.mode;
	const nativeBg = effectiveBackground(resolvedNow);
	// Layout effect: the class lands before any child's passive effect reads
	// theme tokens (graph canvas colors, mermaid) in the same commit.
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.classList.remove(mode === "light" ? "dark" : "light");
		root.classList.add(mode);
		window.lh?.setTheme?.({ mode, background: nativeBg });
	}, [mode, nativeBg]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), onAppearanceChange }),
		[delta, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}