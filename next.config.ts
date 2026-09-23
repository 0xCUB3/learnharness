import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Desktop target (Electron wrapper, 2026-09-17): standalone output = a
	// self-contained .next/standalone/server.js the Electron shell spawns
	// on 127.0.0.1. Harmless for plain web deploys (extra build output).
	// The manual copies the docs require — public/ and .next/static — are
	// done by scripts/build-server.mjs.
	output: "standalone",
	// SAFETY (empirically verified 2026-09-17): without this, output file
	// tracing sweeps the repo's real data/ — chat records, graph ledgers —
	// INTO the standalone bundle. A shipped desktop app would carry the
	// developer's session data inside it.
	outputFileTracingExcludes: {
		"*": [
			"data/**/*",
			// Wave 6 (2026-09-23): the local transformers embeddings died — any
			// @huggingface copy (or its ~300MB model cache, if one ever
			// reappears) must never sweep into the standalone bundle again.
			"node_modules/@huggingface/**/*",
		],
	},
	// Empirically verified gaps (2026-09-17 standalone smoke): the tracer
	// misses JSON loaded via `import ... with { type: "json" }` attributes —
	// pi-ai's provider catalog (39 JSON files) vanished from the trace and
	// the server 500s on module load. Include the whole data dirs of the
	// runtime-loaded engine packages.
	// pdfjs-dist (sources v0 live smoke, 2026-09-19): its legacy build loads
	// the node fake worker (pdf.worker.mjs) and our standard_fonts dir via
	// runtime-resolved paths — invisible to the tracer. Bundling (without
	// serverExternalPackages below) additionally breaks the worker's
	// import.meta.url resolution inside .next/dev chunks — the live smoke
	// caught it; unit tests run unbundled and never see it.
	outputFileTracingIncludes: {
		"*": [
			"node_modules/pdfjs-dist/legacy/**/*",
			"node_modules/pdfjs-dist/standard_fonts/**/*",
			"node_modules/@earendil-works/pi-ai/dist/providers/data/**/*",
			"node_modules/@earendil-works/pi-agent-core/dist/**/*.json",
		],
	},
	// Framework-free core lives in src/ (plain TS, imported by routes and CLI alike).
	// The pi engine must stay external: its providers are runtime-loaded Node
	// code (undici streams, catalog data) that breaks when bundled into routes.
	serverExternalPackages: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"pdfjs-dist", // sources v0: bundling breaks its node fake-worker path
	],
};

export default nextConfig;