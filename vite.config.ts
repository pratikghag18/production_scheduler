import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // Deferred here from design-plan §17.3 -- the board is where the
        // heaviest code lands. Baseline before this change: 548 kB / 161 kB
        // gzipped empty, 560 kB / 165 kB after P1-3b (design-plan §17.3).
        // Not re-measured here -- no npm in this container; the user
        // compares after `npm run build` (brief §11).
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          router: ["react-router-dom"],
          query: ["@tanstack/react-query"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
