import { Home } from "@/components/home";
import { readDefaultSettings, readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

// Dynamic: the default settings record is server-rendered into the page —
// the model + thinking + context controls show truth on the FIRST frame
// (no default-model flash), and every navigation re-reads the record
// (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default function HomePage() {
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin.
	const record = readSettingsRecord();
	return (
		<Home initialSettings={readDefaultSettings()} initialConfigured={slotsConfigured(record?.models)} />
	);
}
