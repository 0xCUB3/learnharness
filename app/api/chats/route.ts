import { createChat, listChats, titleFromPrompt } from "@/src/store/chats";

export async function GET() {
	return Response.json({ chats: listChats() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	const chat = createChat(titleFromPrompt(title || "Untitled session"));
	return Response.json({ id: chat.id, title: chat.title });
}
