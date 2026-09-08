import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"

const root = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		nodePolyfills({ include: ["buffer"], globals: { Buffer: true } }),
		wasm(),
	],
	base: "./",
	build: {
		target: "esnext",
		rollupOptions: {
			input: {
				main: resolve(root, "index.html"), // Authline landing
				app: resolve(root, "app.html"), // activation dApp
				withdraw: resolve(root, "withdraw.html"), // reference integrator (SEP-7 handoff)
			},
		},
	},
	optimizeDeps: { exclude: ["@stellar/stellar-xdr-json"] },
	define: { global: "window" },
	envPrefix: "PUBLIC_",
	server: {
		proxy: {
			"/friendbot": {
				target: "http://localhost:8000/friendbot",
				changeOrigin: true,
			},
		},
	},
})
