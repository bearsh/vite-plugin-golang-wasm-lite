Quickstart

1. From repo root:

```bash
pnpm install
pnpm -w run build    # build plugin if needed
pnpm -w run start:example # run example app (alias for pnpm --filter example-app dev)
```

2. Example app will import a `.go` file and the plugin will build it to WASM during dev.
