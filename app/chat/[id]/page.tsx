import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { getChat } from "@/src/store/chats";
import type { TeacherUIMessage } from "@/src/agent/ui-message";

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
			chatId={chat.id}
			title={chat.title}
			initialMessages={chat.messages as TeacherUIMessage[]}
			initialPrompt={prompt}
		/>
	);
}
