import { defineConfig } from 'vite'
import goWasm from 'vite-plugin-golang-wasm-lite'

export default defineConfig({
   build: {
    target: 'esnext' //browsers can handle the latest ES features
  },
  plugins: [
    goWasm({
      goBuildDir: 'node_modules/.cache/go-wasm',
      goBin: 'node_modules/.cache/go-wasm/bin',
      wasmExecPath: '/usr/local/go/lib/wasm/wasm_exec.js'
    })
  ]
})
