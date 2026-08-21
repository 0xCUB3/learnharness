import React, { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * Markdown — renders assistant prose with LaTeX (KaTeX) and mermaid diagrams
 * (the teacher's Phase-2 dependency maps are mermaid code blocks).
 */

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
function getMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((m) => {
			m.default.initialize({ startOnLoad: false, theme: "dark" });
			return m;
		});
	}
	return mermaidPromise;
}

function MermaidBlock({ code }: { code: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const mermaid = await getMermaid();
				const { svg } = await mermaid.default.render(`mmd-${Math.random().toString(36).slice(2)}`, code);
				if (!cancelled && ref.current) ref.current.innerHTML = svg;
			} catch (e) {
				if (!cancelled) setError(String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [code]);

	if (error) {
		return (
			<pre className="mermaid-error">
				<code>{code}</code>
			</pre>
		);
	}
	return <div className="mermaid" ref={ref} />;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={[remarkMath]}
				rehypePlugins={[rehypeKatex]}
				components={{
					code({ className, children, ...props }) {
						const lang = /language-(\w+)/.exec(className ?? "")?.[1];
						const raw = String(children).replace(/\n$/, "");
						if (lang === "mermaid") return <MermaidBlock code={raw} />;
						return (
							<code className={className} {...props}>
								{children}
							</code>
						);
					},
					pre({ children }) {
						const child = children as { props?: { className?: string } };
						if (child?.props?.className?.includes("language-mermaid")) return <>{children}</>;
						return <pre>{children}</pre>;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
