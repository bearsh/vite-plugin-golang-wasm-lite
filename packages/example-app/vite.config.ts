import { defineConfig } from 'vite'
import goWasm from 'vite-plugin-golang-wasm-lite'

export default defineConfig({
  plugins: [
    goWasm({
      goBuildDir: 'node_modules/.cache/go-wasm',
      goBin: 'node_modules/.cache/go-wasm/bin'
    })
  ]
})
