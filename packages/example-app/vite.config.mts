import { defineConfig } from 'vite'
import goWasm from 'vite-plugin-golang-wasm-lite'

export default defineConfig({
   build: {
    target: 'esnext' //browsers can handle the latest ES features
  },
  plugins: [
    goWasm()
  ]
})
