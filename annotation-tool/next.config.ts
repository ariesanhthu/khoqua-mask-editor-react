import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Only the Docker/Cloudflare Containers build sets this; Vercel builds are unchanged.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
