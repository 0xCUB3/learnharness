/** The settings route (thin settings wave): server shell over the client
 *  page — same shape as the chat routes (AppShell wraps via the root
 *  layout, so the sidebar + its Settings entry come along). */
import { SettingsPage } from "@/components/settings/settings-page.tsx";

export default function Page() {
	return <SettingsPage />;
}