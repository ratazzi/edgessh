import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [wasm(), tailwindcss()],
  build: {
    target: "esnext",
    outDir: "../worker/public",
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
});
