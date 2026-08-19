import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * No dev-server proxy is configured here on purpose. Reddit fetching is
 * handled by the serverless function in api/reddit.ts (deployed to Vercel),
 * so upstream requests originate from Vercel's cloud — not from the user's
 * machine or local network, which may block reddit.com.
 *
 * The frontend calls the same-origin endpoint /api/reddit?subreddit=...&limit=50
 * (see src/api/reddit.ts). Under `vercel dev` the function runs locally;
 * in production Vercel hosts it.
 */

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
