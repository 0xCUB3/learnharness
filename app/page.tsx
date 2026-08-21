import { listChats } from "@/src/store/chats";
import { Home } from "@/components/home";

export const dynamic = "force-dynamic";

export default function HomePage() {
	return <Home chats={listChats()} />;
}
