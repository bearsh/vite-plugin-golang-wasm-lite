import { ResolvedConfig } from 'vite'

export interface Config {
  wasmExecPath?: string
  goBinaryPath?: string
  goBuildDir?: string
  goBuildExtraArgs?: string[]
  goBin?: string
  goArgs?: string[]
  copyDts?: boolean

  buildGoFile?: GoBuilder

  transform?: (command: "build" | "serve", emit: () => Promise<string>, read: () => Promise<Buffer>) => Promise<string | undefined>
}

export type GoBuilder = (config: ResolvedConfig, pluginConfig: Config, id: string) => string | Promise<string>
