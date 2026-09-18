import { NewSession } from "@/components/new-session";
import { readDefaultSettings } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * The draft view behind "+ New session" (owner, 2026-09-13): NO session is
 * created until the first message is sent — the view is a sessionless empty
 * chat; on send it creates the chat (title = that message) and redirects to
 * the real page, whose initialPrompt path delivers the message as turn 1.
 * Static segment beats the dynamic [id] route — "new" is never a chat id.
 *
 * The default settings record is server-rendered in (readDefaultSettings →
 * initialSettings): the controls show truth on the first frame, no
 * default-model flash (the default IS the user's last choice — "no model"
 * only before the first-ever pick).
 */
export default function NewSessionPage() {
	return <NewSession initialSettings={readDefaultSettings()} />;
}
