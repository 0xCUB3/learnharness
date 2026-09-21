import { z } from "zod";
import { lhTool } from "../lh-tool.ts";
// The search-hit shape lives in the core port since the search wave
// (2026-09-20) — this module keeps the historical alias so callers don't
// churn; the tool's rewiring onto the port is the Teacher stream's.
import type { SearchHit as WebSearchResult } from "../../core/search.ts";
export type { WebSearchResult };
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * Server-side web tools for the researcher sub-agent — a minimal port of the
 * pi extensions (~/.pi/agent/extensions/web-search + web-fetch):
 *
 *   web_search(query, count?) → {title, url, snippet}[]   (Google Custom Search)
 *   web_fetch(url)            → readable markdown text     (Readability + Turndown,
 *                                                          Jina Reader fallback for
 *                                                          JS-rendered pages)
 *
 * Credentials come from env (the pi extension used auth.json):
 *   GOOGLE_SEARCH_API_KEY, GOOGLE_CSE_ID
 *
 * Tool contract: NEVER throw into the agent loop — missing credentials and
 * every failure path return a clear error STRING as the tool output, so the
 * researcher can adapt (or report) instead of crashing.
 */

// ── web_search ───────────────────────────────────────────────────────────────
// (WebSearchResult is the core SearchHit, re-exported above.)

function searchCredentials(): { apiKey: string; cseId: string } | null {
	const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
	const cseId = process.env.GOOGLE_CSE_ID;
	return apiKey && cseId ? { apiKey, cseId } : null;
}

async function googleSearch(query: string, count: number, creds: { apiKey: string; cseId: string }): Promise<WebSearchResult[]> {
	const url = new URL("https://www.googleapis.com/customsearch/v1");
	url.searchParams.set("key", creds.apiKey);
	url.searchParams.set("cx", creds.cseId);
	url.searchParams.set("q", query);
	url.searchParams.set("num", String(Math.min(count, 10)));

	const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Google Custom Search API ${resp.status}: ${body.slice(0, 200)}`);
	}
	const data = (await resp.json()) as { items?: Array<{ title: string; link: string; snippet?: string }> };
	return (data.items ?? []).map((item) => ({
		title: item.title,
		url: item.link,
		snippet: item.snippet?.replace(/\n/g, " ") ?? "",
	}));
}

// ── web_fetch ────────────────────────────────────────────────────────────────

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Keep the researcher's context sane — long pages truncate with a marker. */
const MAX_CONTENT_CHARS = 40_000;
const MIN_USEFUL_CONTENT = 200;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function truncate(text: string): string {
	if (text.length <= MAX_CONTENT_CHARS) return text;
	return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[Truncated at ${MAX_CONTENT_CHARS} characters]`;
}

/** Jina Reader fallback for JS-rendered pages (no deps — plain fetch). */
async function fetchViaJina(url: string): Promise<string | null> {
	try {
		const res = await fetch(`https://r.jina.ai/${url}`, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const content = await res.text();
		const marker = "Markdown Content:";
		const start = content.indexOf(marker);
		if (start < 0) return null;
		const markdown = content.slice(start + marker.length).trim();
		if (markdown.length < MIN_USEFUL_CONTENT || markdown.startsWith("Loading...")) return null;
		return markdown;
	} catch {
		return null;
	}
}

function htmlToMarkdown(html: string): { title: string; content: string } | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	const markdown = turndown.turndown(article.content);
	if (markdown.trim().length < MIN_USEFUL_CONTENT) return null;
	return { title: article.title ?? "", content: markdown };
}

async function fetchAndExtract(url: string): Promise<string> {
	const resp = await fetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

	const contentType = resp.headers.get("content-type") ?? "";
	if (contentType.includes("application/pdf")) throw new Error("PDF documents are not supported");
	if (/image\/|audio\/|video\/|zip|octet-stream/.test(contentType)) {
		throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
	}
	const length = Number(resp.headers.get("content-length") ?? 0);
	if (length > MAX_RESPONSE_BYTES) throw new Error("Response too large");

	const text = await resp.text();
	if (!contentType.includes("html")) return truncate(text); // plain text / markdown / code

	const extracted = htmlToMarkdown(text);
	if (extracted) {
		const header = extracted.title ? `# ${extracted.title}\n\nSource: ${url}\n\n---\n\n` : "";
		return header + truncate(extracted.content);
	}
	// Readability failed — likely JS-rendered. Try Jina Reader.
	const jina = await fetchViaJina(url);
	if (jina) return truncate(jina);
	throw new Error("Could not extract readable content (the page may be JavaScript-rendered)");
}

// ── tool registry ────────────────────────────────────────────────────────────

export const webTools = {
	web_search: lhTool({
		name: "web_search",
		description:
			"Search the web via Google Custom Search. One search per call — use one call per search angle. " +
			"Returns an array of results with title, url, and snippet.",
		schema: z.object({
			query: z.string().describe("The search query (a normal search string, phrases included)"),
			count: z.number().int().min(1).max(10).optional().describe("Number of results (default 5, max 10)"),
		}),
		execute: async ({ query, count }): Promise<WebSearchResult[] | string> => {
			const creds = searchCredentials();
			if (!creds) {
				return (
					"web_search is not configured on this server: GOOGLE_SEARCH_API_KEY and/or GOOGLE_CSE_ID " +
					"are missing. Report in your brief that web search is unavailable."
				);
			}
			try {
				return await googleSearch(query, count ?? 5, creds);
			} catch (err) {
				return `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	}),

	web_fetch: lhTool({
		name: "web_fetch",
		description:
			"Fetch a web page and extract its readable content as markdown (Readability). " +
			"Handles HTML pages and plain text; JS-rendered pages fall back to a reader service.",
		schema: z.object({
			url: z.string().describe("The URL to fetch"),
		}),
		execute: async ({ url }): Promise<string> => {
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
			} catch {
				return `web_fetch failed: invalid URL "${url}"`;
			}
			try {
				return await fetchAndExtract(url);
			} catch (err) {
				return `web_fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	}),
};
