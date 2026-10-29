import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { CSP } from "./csp";

const api = process.env.API_URL ?? "http://127.0.0.1:8080";
// one origin for the browser, as behind the production ingress: the API's PUBLIC_URL is this origin
const proxy = Object.fromEntries(["/v1", "/auth", "/dev-idp", "/healthz", "/readyz"].map((p) => [p, { target: api, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1", proxy },
  preview: { port: 4173, host: "127.0.0.1", headers: { "Content-Security-Policy": CSP }, proxy },
  test: { environment: "jsdom", include: ["test/**/*.test.tsx", "test/**/*.test.ts"], setupFiles: ["test/setup.ts"] },
});
