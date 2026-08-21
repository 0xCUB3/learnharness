/**
 * Transcript — the scrollable message list with stick-to-bottom behavior:
 * auto-scrolls while the learner is at the bottom; if they scroll up to read,
 * auto-scrolling pauses and a "jump to latest" pill appears.
 */

import React, { useEffect, useRef, useState, type ReactNode } from "react";

export function Transcript({ children, scrollToken }: { children: ReactNode; scrollToken: string | number }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	const onScroll = () => {
		const el = ref.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		setPinned(atBottom);
	};

	useEffect(() => {
		const el = ref.current;
		if (el && pinned) el.scrollTop = el.scrollHeight;
	}, [scrollToken, pinned]);

	const jumpToLatest = () => {
		const el = ref.current;
		if (el) el.scrollTop = el.scrollHeight;
		setPinned(true);
	};

	return (
		<div className="transcript-wrap">
			<div className="transcript" ref={ref} onScroll={onScroll}>
				{children}
			</div>
			{!pinned && (
				<button type="button" className="jump-latest" onClick={jumpToLatest}>
					↓ Jump to latest
				</button>
			)}
		</div>
	);
}
