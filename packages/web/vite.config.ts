import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Which SuperFabric server this dev bundle talks to. Overridable so a throwaway server on a spare
 * port (a browser check, two factories side by side) does not need a config edit; the default is
 * the one the server package's own `dev` script starts.
 */
const serverPort = Number(process.env.SUPERFABRIC_SERVER_PORT ?? 4620);

export default defineConfig({
  plugins: [react()],
  // The dev server proxies the WebSocket so the app can always talk to a same-origin
  // "/ws" and never needs to know the server's port. `/attachments` is the upload endpoint on
  // the same Fastify server and is proxied for the same reason — and the browser's `Origin`
  // (the Vite origin) is forwarded unchanged, which is what the server's allow-list checks, so a
  // non-default Vite port needs `SUPERFABRIC_ALLOWED_ORIGINS` on the server.
  server: {
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/attachments": { target: `http://127.0.0.1:${serverPort}` },
    },
  },
});
