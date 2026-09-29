/**
 * The practice list page (slice 5): the set list, server-prefetched
 * (force-dynamic — a static list would go stale between requests), the
 * client body owns polling + dialogs. Reads through the server barrel
 * only (app/ never touches src/store directly).
 */
import { listPracticeSets } from "@/src/server";
import { PracticeListPage } from "@/components/practice-list";

export const dynamic = "force-dynamic";

export default function Page() {
	return <PracticeListPage initialSets={listPracticeSets()} />;
}
