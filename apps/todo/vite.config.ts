import { getRequestListener } from "@hono/node-server";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { VitePWA } from "vite-plugin-pwa";
import { createTodoApi } from "./server/app";
import { loadTodoEnvironment } from "./server/environment";

export default defineConfig(({ mode }) => {
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        devOptions: { enabled: true },
        manifest: {
          name: "Daylight — Notion tasks",
          short_name: "Daylight",
          description: "An instant, offline-ready personal task workspace backed by Notion.",
          theme_color: "#f5f7fa",
          background_color: "#f5f7fa",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
        },
      }),
      {
        name: "daylight-local-api",
        async configureServer(server) {
          const environment = loadTodoEnvironment(mode);
          const api = await createTodoApi(environment);
          const apiListener = getRequestListener(api.fetch);
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/api/")) return next();
            void apiListener(request, response);
          });
        },
      },
    ],
    resolve: {
      dedupe: ["@tanstack/db", "@tanstack/react-db", "react", "react-dom"],
    },
    server: { port: 5174 },
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
    },
    fmt: {
      ignorePatterns: ["dist/**", "dev-dist/**", "artifacts/**"],
    },
    lint: {
      ignorePatterns: ["dist/**", "dev-dist/**", "artifacts/**"],
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: { "vite-plus/prefer-vite-plus-imports": "error" },
      options: { typeAware: true, typeCheck: true },
    },
  };
});
