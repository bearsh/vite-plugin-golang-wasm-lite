# vite-plugin-golang-wasm-lite

[![npm version](https://img.shields.io/npm/v/vite-plugin-golang-wasm-lite.svg)](https://www.npmjs.com/package/vite-plugin-golang-wasm-lite)

An opinionated Vite plugin for importing Go packages as WebAssembly modules with the `go:` prefix.

It started as a fork of [`vite-plugin-golang-wasm`](https://github.com/slainless/vite-plugin-golang-wasm), with a stronger focus on straightforward local-package usage and support for remote module installs.

## Compatibility

- ESM-only environments
- `vite: ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0`
- `rollup: ^3.0.0 || ^4.0.0`
- Node LTS, effectively Node 18+
- Go modules enabled

## Install

```bash
pnpm add -D vite-plugin-golang-wasm-lite
```

Equivalent commands for other package managers:

```bash
npm install -D vite-plugin-golang-wasm-lite
yarn add -D vite-plugin-golang-wasm-lite
```

## Prerequisites

- A working Go toolchain must be available, either in `PATH` or via `goBinaryPath`.
- The plugin must be able to resolve `wasm_exec.js`, either automatically or via `wasmExecPath`.
- Imported Go packages must compile as `package main` for WebAssembly.
- TypeScript users should provide `*.d.ts` declarations for `go:` imports.

## Quickstart

Register the plugin in your Vite config:

```ts
import { defineConfig } from 'vite'
import goWasm from 'vite-plugin-golang-wasm-lite'

export default defineConfig({
  plugins: [goWasm()],
})
```

Create a Go package that exposes values on `globalThis.__go_wasm__`:

```go
// ./src/math/main.go
package main

import (
	"fmt"
	"syscall/js"
)

const (
	goWasmName = "__go_wasm__"
	readyHint  = "__ready__"
)

var goWasm = js.Global().Get(goWasmName)

func ready() {
	goWasm.Set(readyHint, true)
}

func main() {
	fmt.Println("example math module")

	goWasm.Set("add", js.FuncOf(func(this js.Value, args []js.Value) any {
		a := args[0].Int()
		b := args[1].Int()
		return a + b
	}))

	ready()
	select {}
}
```

Import it from your app with the `go:` prefix:

```ts
import goMath from 'go:./math'

const el = document.getElementById('app')

if (el) {
  el.innerHTML = `
    <div>
      <h1>Vite + Go WASM Demo</h1>
      <p>The Go function <code>add(1, 2)</code> was imported and executed.</p>
      <p>Result: <strong>${goMath.add(1, 2)}</strong></p>
    </div>
  `
}
```

Add a matching TypeScript declaration:

```ts
// ./src/math/go-modules.d.ts
declare module 'go:./math' {
  const mod: {
    add: (x: number, y: number) => number
  }

  export default mod
}
```

## Local And Remote Imports

Local package import:

```ts
import goMath from 'go:./math'
```

Remote module import:

```ts
import tool from 'go:github.com/owner/repo/cmd/tool@v1.2.3'
```

If no version is specified for a remote import, the plugin uses `@latest`.

## How It Works

Each `go:` import is transformed into a JavaScript module that:

- loads `wasm_exec.js`
- loads the runtime bridge
- fetches the generated `.wasm`
- instantiates the module and returns a proxy around `__go_wasm__`

Default build-mode output is equivalent to:

```ts
import 'virtual:wasm_exec'
import goWasm from 'virtual:wasm_bridge'

const wasm = fetch(import.meta.ROLLUP_FILE_URL_<reference>).then((r) => r.arrayBuffer())
export default await goWasm(wasm)
```

In `serve` mode, the WASM is inlined as a base64 `data:` URL by default.

## Configuration

```ts
export interface Config {
  wasmExecPath?: string
  goBinaryPath?: string
  goBuildDir?: string
  goDtsDir?: string
  goBuildExtraArgs?: string[]
  goBin?: string
  goArgs?: string[]
  copyDts?: boolean
  buildGoFile?: GoBuilder
  transform?: (
    command: 'build' | 'serve',
    emit: () => Promise<string>,
    read: () => Promise<Buffer>
  ) => Promise<string | undefined>
}
```

### Option Notes

`goBinaryPath`, `wasmExecPath`

- `goBinaryPath` defaults to `go`, unless `GOROOT` is set, in which case the plugin also tries `GOROOT/bin/go`.
- `wasmExecPath` is resolved from the Go installation. If `GOROOT` is not set, the plugin tries `go env GOROOT`.
- If `wasm_exec.js` still cannot be resolved, set `wasmExecPath` explicitly.

```ts
export default defineConfig({
  plugins: [
    goWasm({
      goBinaryPath: '/path/to/go/bin/go',
      wasmExecPath: '/path/to/go/lib/wasm/wasm_exec.js',
    }),
  ],
})
```

`goBuildDir`

- Directory used for build artifacts and temporary Go build state.
- By default, the plugin creates and cleans up a temporary directory for the lifetime of the Vite process.

`goDtsDir`

- Output directory for copied `*.d.ts` files.
- Default: `node_modules/@types/vite-plugin-golang-wasm-lite`, resolved from the Vite project root.

If your `tsconfig.json` uses `compilerOptions.types`, add the generated type package explicitly:

```json
{
  "compilerOptions": {
    "types": ["vite/client", "vite-plugin-golang-wasm-lite"]
  }
}
```

`goArgs`

- Extra arguments passed to both `go build` and `go install`.

```ts
export default defineConfig({
  plugins: [
    goWasm({
      goArgs: ['-tags', 'mytag', '-ldflags', '-s -w'],
    }),
  ],
})
```

`goBin`

- Exposed in the public config interface.
- The current remote-install implementation uses a deterministic Go build directory rooted at `goBuildDir` and does not rely on `GOBIN` during cross-compiled installs.

`copyDts`

- Defaults to `true`.
- For local packages, package-local `*.d.ts` files are copied into `goDtsDir`.
- For remote modules, the plugin attempts a best-effort lookup in the Go module cache and copies matching `*.d.ts` files when found.

`buildGoFile`

- Hook for overriding the default build behavior.
- The default implementation lives in [src/build.ts](src/build.ts).

`transform`

- Lets you override the generated JavaScript wrapper.
- Signature:

```ts
(command: 'build' | 'serve', emit: () => Promise<string>, read: () => Promise<Buffer>) => Promise<string | undefined>
```

Example that always emits the WASM as an asset:

```ts
import { defineConfig } from 'vite'
import goWasm, { WASM_BRIDGE_ID, WASM_EXEC_ID } from 'vite-plugin-golang-wasm-lite'

export default defineConfig({
  plugins: [
    goWasm({
      async transform(_command, emit) {
        return `
          import '${WASM_EXEC_ID}';
          import goWasm from '${WASM_BRIDGE_ID}';

          const wasm = fetch(import.meta.ROLLUP_FILE_URL_${await emit()}).then((r) => r.arrayBuffer());
          export default await goWasm(wasm);
        `
      },
    }),
  ],
})
```

## Limitations

- Go WebAssembly entrypoints must be `package main`.
- Type declarations are not generated from Go source automatically.
- Remote `*.d.ts` discovery is best-effort and depends on module-cache layout.
- This package is ESM-only.

## Developing This Repository

From the repository root:

```bash
pnpm install
pnpm build
pnpm start:example
```

The example app lives in [packages/example-app](packages/example-app).

## Troubleshooting

`wasm_exec.js` cannot be found

- Ensure the Go toolchain is installed.
- Check that `go env GOROOT` works.
- If needed, set `wasmExecPath` explicitly.

`no go.mod found for local go package`

- Local `go:` imports are resolved relative to the importing file.
- The plugin walks upward from that package until it finds a `go.mod`.

TypeScript cannot resolve `go:` imports

- Add a matching `*.d.ts` declaration.
- If using `compilerOptions.types`, include `vite-plugin-golang-wasm-lite`.

Remote module builds do not expose types

- The plugin only copies declarations if matching `*.d.ts` files are present in the module cache.
- Use `buildGoFile` if you need stricter control over remote-module handling.

## Dependencies

- `exit-hook` is used to clean up temporary directories on process exit.

## License

MIT

Originally created by [slainless](https://github.com/slainless), modified by [bearsh](https://github.com/bearsh).
