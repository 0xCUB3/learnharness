"use client";
/**
 * THE SETTINGS PAGE (thin settings wave, 2026-09-19): one column, section
 * blocks in fixed order — General, Agent, Appearance, Graph, Keyboard —
 * over the versioned delta record at GET /api/settings, written per
 * section through PUT /api/settings/[section] (replace-whole).
 *
 * Thin by owner decision: simple controls, real read/write, the point is
 * a WORKING validation surface that exercises the whole settings schema —
 * not the designed settings app. Polish lives in a later wave.
 *
 * The chat section (new-session defaults) is deliberately NOT here
 * (owner decision): its controls live on the /chat/new surface; two
 * editors for one value is a drift bug. The auth/provider-keys page is
 * deliberately absent (needs auth.json plumbing that doesn't exist).
 */

import { useCallback, useEffect, useState } from "react";
import { CURRENT_SETTINGS_VERSION, type AgentSettings, type AppearanceSettings, type GraphSettings, type UserSettings } from "@/src/core";
import { SidebarToggle } from "@/components/sidebar.tsx";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection, SettingsRow, Toggle } from "./controls.tsx";
import { AgentSection } from "./agent-section.tsx";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";

export function SettingsPage() {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// 200 {settings: null} is FIRST BOOT (no record = factory everything),
		// not a failure — the error state is a non-200 or a network throw only.
		fetch("/api/settings")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: { settings: UserSettings | null }) =>
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }),
			)
			.catch(() => setRecord(null));
	}, []);

	/** ONE writer per page: PUT the whole section, keep the record mirror
	 *  in sync, surface route errors inline (a 400 is this wave's point —
	 *  the validation surface catching schema mistakes). */
	const write = useCallback(
		async (section: "general" | "agent" | "appearance" | "graph", body: object) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as { error?: string };
				setError(`${section}: ${detail.error ?? res.status}`);
				return;
			}
			setRecord((prev) => ({ ...(prev ?? {}), [section]: body }) as UserSettings);
			if (section === "appearance") onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);

	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The app header — same 60px band, same border, same CMU title
				    (the alignment constant from header round 6). */}
				<header className="flex h-15 items-center gap-3 border-b border-border px-3">
					<SidebarToggle />
					<div className="min-w-0 flex-1 truncate font-title text-2xl tracking-tight">Settings</div>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-2xl pb-16">
						{error && (
							<p role="alert" className="m-3 rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
								{error}
							</p>
						)}
						{record === undefined ? (
							<p className="px-6 py-5 text-xs text-muted-foreground/70">Loading settings…</p>
						) : record === null ? (
							<p className="px-6 py-5 text-xs text-muted-foreground/70">
								Settings could not be loaded — refresh to retry.
							</p>
						) : (
							<>
								<SettingsSection title="General" hint="App-level behavior" testid="section-general">
									<SettingsRow label="Auto-update" hint="The update mechanism ships in a later wave" testid="row-auto-update">
										<Toggle
											checked={record.general?.autoUpdate ?? true}
											label="auto update"
											onChange={(on) => void write("general", { autoUpdate: on })}
										/>
									</SettingsRow>
								</SettingsSection>

								<SettingsSection
									title="Agent"
									hint="Background-role models, tools, and prompt overrides"
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										onSectionChange={(next: AgentSettings) => void write("agent", next)}
									/>
								</SettingsSection>

								<SettingsSection title="Appearance" hint="Applied live as CSS variables" testid="section-appearance">
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) => void write("appearance", next)}
									/>
								</SettingsSection>

								<SettingsSection title="Graph" hint="Dependency ladder — a disabled rung grays everything below it" testid="section-graph">
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) => void write("graph", next)}
									/>
								</SettingsSection>

								<SettingsSection title="Keyboard" hint="Rebinds apply instantly — stored in this browser" testid="section-keyboard">
									<KeyboardSection />
								</SettingsSection>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}