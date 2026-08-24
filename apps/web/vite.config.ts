import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Proxy multiplayer API (Go) durante o dev
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
