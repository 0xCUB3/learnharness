import { createChat, getChat, listChats, titleFromPrompt } from "../store/chats.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the fs store; the
 * services stage carves the real orchestration behind this same surface.
 */

export { createChat, getChat, listChats, titleFromPrompt };
