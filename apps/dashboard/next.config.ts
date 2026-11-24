import type { NextConfig } from "next";

const config: NextConfig = {
	output: "standalone",
	// The board and Rivet clients run on the server only; keep them out of the bundler.
	serverExternalPackages: ["rivetkit", "@vercel/board"],
};

export default config;
