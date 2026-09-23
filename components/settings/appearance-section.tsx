"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Hex inputs commit on blur/Enter; the background derives the
 * raised/accent/edge palette in code (components/settings/appearance.tsx).
 * Mode is dark-only this wave: control rendered DISABLED with a note — the
 * light palette is the design wave's work, and a lying control is worse
 * than an honest disabled one.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 */

import type { AppearanceSettings, GraphSettings } from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { CommitInput, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
	const md = appearance?.mdRendering;

	return (
		<>
			<SettingsRow label="Mode" hint="Light ships with the design wave" testid="row-mode" dimmed>
				<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
					<option value="dark">Dark</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Background"
				hint={`Empty = ${resolved.background ?? "#141414"}`}
				testid="row-background"
			>
				<CommitInput
					value={appearance?.background ?? ""}
					placeholder="#141414"
					ariaLabel="background hex"
					testid="input-background"
					onCommit={(v) => onSectionChange({ ...appearance, background: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Reading font"
				hint="Empty = Source Sans 3"
				testid="row-font"
			>
				<CommitInput
					value={appearance?.fontFamily ?? ""}
					placeholder="Source Sans 3"
					ariaLabel="font family"
					testid="input-font"
					onCommit={(v) => onSectionChange({ ...appearance, fontFamily: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): omit the key so the record
						// UNSETS and the field stays empty (absence, not null, is the
						// unset for numbers). Number("") is 0, so the old clamp wrote 12.
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): Number("") is 0, so
						// Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Bold color" hint="Empty = #ee928c" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="#ee928c"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="Empty = #6fa9d6" testid="row-italic-color">
				<CommitInput
					value={md?.italicColor ?? ""}
					placeholder="#6fa9d6"
					ariaLabel="italic color"
					testid="input-italic-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH ONLY. The embedding/clustering/labeling rungs and the BYOK
	// embedding-model picker are gone — clustering is the free birth-session
	// partition derived on read, labels ARE session names, and the prober's
	// graph tools read the ledgers directly. There is nothing left to
	// configure but on/off.
	return (
		<SettingsRow label="Graph" testid="graph-row-enabled">
			<Toggle
				checked={graph?.enabled ?? true}
				label="graph enabled"
				onChange={(on) => onSectionChange({ enabled: on })}
			/>
		</SettingsRow>
	);
}