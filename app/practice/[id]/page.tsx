/**
 * One exam page (slice 5): the set server-prefetched, notFound() on an
 * unknown id; the client body owns polling (generation + grading),
 * answering, and the reveal.
 */
import { notFound } from "next/navigation";
import { getPracticeSet } from "@/src/server";
import { PracticeExam } from "@/components/practice-exam";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const set = getPracticeSet(id);
	if (!set) notFound();
	return <PracticeExam initial={set} />;
}
