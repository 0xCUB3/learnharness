import { handleChatRequest } from "@/src/server/chat-handler";

export async function POST(req: Request) {
	return handleChatRequest(req);
}
