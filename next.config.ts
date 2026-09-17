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
		"*": ["data/**/*"],
	},
	// Empirically verified gaps (2026-09-17 standalone smoke): the tracer
	// misses JSON loaded via `import ... with { type: "json" }` attributes —
	// pi-ai's provider catalog (39 JSON files) vanished from the trace and
	// the server 500s on module load. Include the whole data dirs of the
	// runtime-loaded engine packages.
	outputFileTracingIncludes: {
		"*": [
			"node_modules/@earendil-works/pi-ai/dist/providers/data/**/*",
			"node_modules/@earendil-works/pi-agent-core/dist/**/*.json",
			// onnxruntime-node: the .node binding was traced, but its
			// sibling dylib (libonnxruntime.*.dylib, dlopen'd via @rpath)
			// was not — dlopen fails at module load.
			"node_modules/onnxruntime-node/bin/**/*",
		],
	},
	// Framework-free core lives in src/ (plain TS, imported by routes and CLI alike).
	// The pi engine must stay external: its providers are runtime-loaded Node
	// code (undici streams, catalog data) that breaks when bundled into routes.
	// transformers.js (embeddings) is runtime-loaded ONNX — same reason as
	// the pi engine: bundling onnxruntime-node breaks route builds.
	serverExternalPackages: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@huggingface/transformers",
	],
};

export default nextConfig;