import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows local dev sessions to use a fresh output directory when a stale
  // generated trace file is locked by another Next.js process.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pdfkit"],
  outputFileTracingIncludes: {
    // The DB layer runs Drizzle migrations from `drizzle/` at runtime using a
    // path built from process.cwd(), so it is not statically traceable.
    "/*": ["./drizzle/**", "./public/fonts/**", "./node_modules/pdfkit/js/data/**"],
    "/api/**": ["./drizzle/**", "./public/fonts/**", "./node_modules/pdfkit/js/data/**"],
  },
};

export default nextConfig;
