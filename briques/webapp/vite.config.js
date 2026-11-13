import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// L'interface vit dans client/ et se construit dans dist/, que le serveur sert.
// « @/ » désigne client/src (les imports des composants shadcn/ui).
export default defineConfig({
  root: "client",
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./client/src", import.meta.url)) } },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
})
