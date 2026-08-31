import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import type { TeacherUIMessage } from "@/src/core";
import { getChat, isTurnRunning } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			initialMessages={chat.messages as TeacherUIMessage[]}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
		/>
	);
}
