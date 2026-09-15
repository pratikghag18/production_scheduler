import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { handleTraceRequest } from "./src/lib/voice/traceServer";

/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §3): the bar
 * posts each finished sentence's trace entry to this dev-only endpoint,
 * fire-and-forget, only when `import.meta.env.DEV` -- so this plugin exists
 * only where `configureServer` runs at all (`npm run dev`, and the tester's
 * own dev server), never in a build. The handler itself is
 * `src/lib/voice/traceServer.ts`, a plain module `traceServer.test.ts` can
 * call directly -- this plugin is just the thin wire-up.
 */
function voiceTracePlugin(): Plugin {
  return {
    name: "voice-trace",
    configureServer(server) {
      server.middlewares.use("/__trace", (req, res) => {
        void handleTraceRequest(req, res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), voiceTracePlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // R-366: the tester runs its own dev server on a port of its own, passed
    // as `npm run dev -- --port <E2E_PORT>` (playwright.config.ts, via
    // e2e/env.ts). The CLI flag overrides this default, so it stays 5173 for
    // the developer, who exports nothing.
    port: 5173,
    proxy: {
      // R-393: the voice command bar talks to the local model service
      // (`npm run voice:serve`, 127.0.0.1:8089) through this proxy rather
      // than a direct cross-origin fetch, so the browser sees one origin
      // and the service needs no CORS headers of its own.
      "/voice": {
        target: "http://127.0.0.1:8089",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/voice/, ""),
      },
      // S57-a / D131: the local (whisper.cpp) recogniser, `npm run
      // voice:serve`'s second container, 127.0.0.1:8090 -- the same pattern
      // as `/voice` above, one proxy entry per local service.
      "/whisper": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/whisper/, ""),
      },
    },
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
