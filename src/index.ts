import type { PluginOption, ResolvedConfig } from 'vite'
import type { SourceDescription, TransformPluginContext } from 'rollup'
import { basename, join, dirname, resolve } from 'node:path'

import { WASM_BRIDGE_ID, WASM_EXEC_ID, readFile } from './dependency.js'
import { readFile as r } from 'node:fs/promises'
import { createTempDir } from './temp_dir.js'
import { buildFile } from './build.js'
import type { Config } from './interface.js'

const GO_PREFIX = 'go:'
const GO_LOCAL_ID_PREFIX = '\0go:local:'
const GO_REMOTE_ID_PREFIX = '\0go:remote:'

const stripQuery = (id: string) => id.split('?')[0].split('#')[0]
const isGoImport = (id: string) => stripQuery(id).startsWith(GO_PREFIX)
const isGoResolvedId = (id: string) => id.startsWith(GO_LOCAL_ID_PREFIX) || id.startsWith(GO_REMOTE_ID_PREFIX)
const isLocalGoImport = (source: string) => {
  const request = stripQuery(source).slice(GO_PREFIX.length)
  return request.startsWith('./') || request.startsWith('../') || request.startsWith('/')
}
const getGoAssetName = (id: string) => {
  if (id.startsWith(GO_LOCAL_ID_PREFIX)) {
    return `${basename(id.slice(GO_LOCAL_ID_PREFIX.length))}.wasm`
  }

  if (id.startsWith(GO_REMOTE_ID_PREFIX)) {
    const moduleRef = id.slice(GO_REMOTE_ID_PREFIX.length)
    const noVersion = moduleRef.split('@')[0]
    return `${basename(noVersion)}.wasm`
  }

  return 'module.wasm'
}

export type { Config, GoBuilder } from './interface.js'

export { WASM_BRIDGE_ID, WASM_EXEC_ID } from './dependency.js'

export default (config?: Config) => {
  const finalConfig = Object.assign({} satisfies Config, config)

  let cfg: ResolvedConfig

  if (finalConfig.wasmExecPath == null) {
    if (process.env.GOROOT == null) {
      throw new Error("GOROOT is not set and no wasm exec path provided!")
    }
    finalConfig.wasmExecPath = join(process.env.GOROOT as string, "misc", "wasm", "wasm_exec.js")
  }

  if (finalConfig.goBinaryPath == null) {
    if (process.env.GOROOT == null) {
      throw new Error("GOROOT is not set and no go binary path provided!")
    }
    finalConfig.goBinaryPath = join(process.env.GOROOT as string, "bin", "go")
  }

  return {
    name: "golang-wasm" as const,
    enforce: 'pre' as const,
    configResolved(c: any) {
      cfg = c
    },
    async resolveId(this: any, source, importer): Promise<string | undefined> {
      if (source == WASM_EXEC_ID) {
        return `\0${WASM_EXEC_ID}`
      }

      if (source == WASM_BRIDGE_ID) {
        return `\0${WASM_BRIDGE_ID}`
      }

      if (!isGoImport(source)) {
        return
      }

      const request = stripQuery(source).slice(GO_PREFIX.length)
      if (isLocalGoImport(source)) {
        const importerDir = importer != null ? dirname(stripQuery(importer)) : cfg.root
        const resolvedPath = request.startsWith('/') ? request : resolve(importerDir, request)
        return `${GO_LOCAL_ID_PREFIX}${resolvedPath}`
      }

      return `${GO_REMOTE_ID_PREFIX}${request}`
    },
    async options(this: any) {
      if (finalConfig.goBuildDir == null) {
        finalConfig.goBuildDir = await createTempDir(cfg)
      }
    },
    async load(this: any, id): Promise<string | Pick<SourceDescription, "code" | "moduleSideEffects"> | undefined> {
      if (id == `\0${WASM_EXEC_ID}`) {
        return {
          code: await readFile(cfg, finalConfig.wasmExecPath as string),
          moduleSideEffects: "no-treeshake"
        }
      }

      if (id == `\0${WASM_BRIDGE_ID}`) {
        const base = import.meta.url != null ? new URL('artifact/bridge.js', import.meta.url) : join(dirname(__filename), 'artifact', 'bridge.js')
        return {
          code: await readFile(cfg, base),
          moduleSideEffects: "no-treeshake"
        }
      }

      if (!isGoResolvedId(id)) {
        return
      }

      // intentionally left empty
      return ``
    },
    async transform(this: any, code, id): Promise<string | undefined> {
      if (!isGoResolvedId(id)) {
        return
      }

      const builder = finalConfig.buildGoFile != null ? finalConfig.buildGoFile : buildFile
      try {
        const wasmPath = await builder(cfg, finalConfig, id)
        const emit = async () => (this.emitFile as TransformPluginContext['emitFile'])({
          type: "asset",
          name: getGoAssetName(id),
          source: await r(wasmPath)
        })
        // Important: read WASM as binary, not utf-8 text.
        const read = async () => await r(wasmPath)

        if(config?.transform != null) {
          return config.transform(cfg.command, emit, read)
        }

        const contentExpr = cfg.command == 'build'
          ? `import.meta.ROLLUP_FILE_URL_` + await emit()
          : JSON.stringify(`data:application/wasm;base64,` + Buffer.from(await read()).toString("base64"))

        return `
          import '${WASM_EXEC_ID}';
          import goWasm from '${WASM_BRIDGE_ID}';

          const wasm = fetch(${contentExpr}).then(r => r.arrayBuffer());
          export default await goWasm(wasm);
        `
      } catch (e) {
        cfg.logger.error(`fail to build wasm for: ${id}`, {
          error: e as Error
        })
        throw e
      }

      return
    },
  } satisfies PluginOption
}