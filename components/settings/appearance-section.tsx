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
 * Graph is the dependency ladder (owner decision, 2026-09-19): a disabled
 * parent grays its dependents — stored values persist but resolve inert.
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
			<SettingsRow label="Mode" hint="Light mode ships with the design wave" testid="row-mode">
				<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
					<option value="dark">Dark</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Background"
				hint={`One color; raised/accent/edges derive from it. Empty = the dark default (${resolved.background ?? "#141414"})`}
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
				hint="Font family name, by name — everything that reads today's Source Sans 3. Empty = Source Sans 3"
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
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px — prose, inputs, session titles scale together`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" hint="CMU Serif titles on/off" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight} — CSS resolves the nearest cut`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Bold color" hint="**Bold** spans in teaching prose. Empty = the default ink" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="#c96b4a"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="*Italic* spans. Empty = the default ink" testid="row-italic-color">
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

const LADDER: readonly {
	key: keyof GraphSettings;
	label: string;
	needs: keyof GraphSettings | null;
	hint: string;
}[] = [
	{ key: "enabled", label: "Graph", needs: null, hint: "Master: off = no extraction, embedding, or injection" },
	{ key: "embedding", label: "Embedding", needs: "enabled", hint: "Vectors + graph-context injection" },
	{ key: "clustering", label: "Clustering", needs: "embedding", hint: "Cluster computation + settle" },
	{ key: "labeling", label: "Labeling", needs: "clustering", hint: "The LLM cluster-namer" },
];

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Stored values (the switches show these) vs EFFECTIVE values (a
	// stored-on rung under a broken chain is inert — the schema's ladder).
	const stored = {
		enabled: graph?.enabled ?? true,
		embedding: graph?.embedding ?? true,
		clustering: graph?.clustering ?? true,
		labeling: graph?.labeling ?? true,
	};
	const effective = {
		enabled: stored.enabled,
		embedding: stored.enabled && stored.embedding,
		clustering: stored.enabled && stored.embedding && stored.clustering,
		labeling: stored.enabled && stored.embedding && stored.clustering && stored.labeling,
	};
	return (
		<>
			{LADDER.map(({ key, label, needs, hint }) => {
				// Touchable only when every ancestor is EFFECTIVELY on.
				const parentOn = needs === null ? true : effective[needs];
				return (
					<SettingsRow key={key} label={label} hint={!parentOn ? `${hint} — needs ${needs} on` : hint} testid={`graph-row-${key}`}>
						<Toggle
							checked={stored[key]}
							disabled={!parentOn}
							label={`graph ${key}`}
							onChange={(on) => onSectionChange({ ...graph, [key]: on })}
						/>
					</SettingsRow>
				);
			})}
		</>
	);
}