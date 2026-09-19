"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { cn } from "@/lib/utils";

/** A section block: pronounced mono heading + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="px-6 py-5">
			<h2 className="text-sm uppercase tracking-widest text-foreground">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
			<div className="mt-4 flex flex-col gap-3">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
			<div className="flex flex-col gap-2">{children}</div>
		</div>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 py-1", dimmed && "opacity-40")}>
			<span className="min-w-0">
				<span className="block font-prose text-(length:--lh-prose-size)">{label}</span>
				{hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-4.5 w-8 shrink-0 rounded-full border border-border transition-colors",
				// Owner (2026-09-20): on is a gray track with a WHITE disc (a full-white
				// track was too loud); off stays the muted track.
				checked ? "bg-muted-foreground" : "bg-muted",
				disabled && "cursor-not-allowed",
			)}
		>
			<span
				className={cn(
					"absolute left-0 top-0.5 size-3 rounded-full transition-transform",
					// 2px inset from each inner edge, both states (owner round: the on
					// disc used to touch the pill's right edge).
					checked ? "translate-x-4 bg-foreground" : "translate-x-0.5 bg-muted-foreground",
				)}
			/>
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	return (
		<input
			type={type}
			defaultValue={value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onBlur={(e) => {
				const next = e.target.value.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					e.currentTarget.value = value;
					e.currentTarget.blur();
				}
			}}
			className="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
		/>
	);
}