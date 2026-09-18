import { Home } from "@/components/home";
import { readDefaultSettings } from "@/src/server";

// Dynamic: the default settings record is server-rendered into the page —
// the model + thinking + context controls show truth on the FIRST frame
// (no default-model flash), and every navigation re-reads the record
// (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default function HomePage() {
	return <Home initialSettings={readDefaultSettings()} />;
}
