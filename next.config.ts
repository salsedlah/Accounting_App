import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows local dev sessions to use a fresh output directory when a stale
  // generated trace file is locked by another Next.js process.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pdfkit"],
  outputFileTracingIncludes: {
    "/api/**": ["./public/fonts/**"],
  },
};

export default nextConfig;
