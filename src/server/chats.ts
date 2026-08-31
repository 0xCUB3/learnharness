import { stores } from "./stores.ts";
import { titleFromPrompt } from "../core/contracts.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
