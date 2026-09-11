import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Framework-free core lives in src/ (plain TS, imported by routes and CLI alike).
	// The pi engine must stay external: its providers are runtime-loaded Node
	// code (undici streams, catalog data) that breaks when bundled into routes.
	serverExternalPackages: ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"],
};

export default nextConfig;