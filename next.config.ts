import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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