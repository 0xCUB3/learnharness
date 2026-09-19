"use client";
/**
 * Thin settings primitives (thin settings wave): the minimal control kit
 * the settings page needs — deliberately plain. No design system, no
 * animation polish: this wave is a WORKING validation surface over the
 * settings record, not the designed settings app (that's a later wave).
 *
 * Everything SSRs clean (render tests pin the sections' markup).
 */

import { cn } from "@/lib/utils";

/** A section block: header + rows, separated by the app's border color. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One-line quiet note under the header (what the section controls). */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="border-t border-border px-6 py-5 first:border-t-0">
			<h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground/70">{hint}</p>}
			<div className="mt-3 flex flex-col gap-3">{children}</div>
		</section>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="flex items-center justify-between gap-4 py-1">
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
				checked ? "bg-foreground" : "bg-muted",
				disabled && "cursor-not-allowed opacity-40",
			)}
		>
			<span
				className={cn(
					"absolute top-0.5 size-3 rounded-full transition-transform",
					checked ? "translate-x-4.5 bg-background" : "translate-x-0.5 bg-muted-foreground",
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
				disabled && "cursor-not-allowed opacity-40",
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