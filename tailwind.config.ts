import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Cairo Variable", "Tahoma", "Arial", "sans-serif"],
        mono: ["Consolas", "monospace"],
      },
      colors: {
        brand: {
          50: "#eef7f4",
          100: "#d5ebe3",
          200: "#aad7c8",
          300: "#75bba4",
          400: "#479d83",
          500: "#2b816b",
          600: "#1e6756",
          700: "#1a5346",
          800: "#17433a",
          900: "#143831",
        },
        ink: {
          50: "#f6f7f8",
          100: "#eceef0",
          200: "#d5d9de",
          300: "#b1b9c3",
          400: "#8692a1",
          500: "#667485",
          600: "#505c6c",
          700: "#424b58",
          800: "#3a414b",
          900: "#13171c",
        },
        danger: "#b42318",
        warn: "#b54708",
        ok: "#067647",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1)",
      },
    },
  },
  plugins: [],
};

export default config;
