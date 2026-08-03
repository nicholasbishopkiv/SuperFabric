import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The dev server proxies the WebSocket so the app can always talk to a same-origin
  // "/ws" and never needs to know the server's port.
  server: { proxy: { "/ws": { target: "ws://127.0.0.1:4620", ws: true } } },
});
