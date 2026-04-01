import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { basename, join, relative, dirname, parse, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { GoBuilder } from './interface.js'

const GO_LOCAL_ID_PREFIX = '\0go:local:'
const GO_REMOTE_ID_PREFIX = '\0go:remote:'
const stripQuery = (id: string) => id.split('?')[0].split('#')[0]

const isDeclarationFile = (name: string) => name.endsWith('.d.ts')

const findModuleRoot = (startPath: string): string | null => {
  let dir = startPath
  const root = parse(dir).root
  while (true) {
    if (existsSync(join(dir, 'go.mod'))) return dir
    if (dir === root) break
    dir = join(dir, '..')
  }
  return null
}

const listWasmFiles = (dir: string) => {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.wasm'))
  } catch (_) {
    return []
  }
}

const listBuildArtifacts = (dir: string) => {
  try {
    return readdirSync(dir).filter(f => {
      if (f.endsWith('.d.ts')) return false
      if (f.startsWith('.')) return false
      try {
        return statSync(join(dir, f)).isFile()
      } catch (_) {
        return false
      }
    })
  } catch (_) {
    return []
  }
}

const GO_ENV_VARS = ['GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE'] as const
type GoEnvKey = typeof GO_ENV_VARS[number]

const queryGoEnv = (goBinExe: string): Record<GoEnvKey, string> => {
  try {
    const out = execFileSync(goBinExe, ['env', ...GO_ENV_VARS]).toString().trim().split('\n')
    return Object.fromEntries(GO_ENV_VARS.map((k, i) => [k, out[i]?.trim() ?? ''])) as Record<GoEnvKey, string>
  } catch (_) {
    return Object.fromEntries(GO_ENV_VARS.map(k => [k, ''])) as Record<GoEnvKey, string>
  }
}

const escapeGoModCacheSegment = (segment: string) => segment.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)

const getModulePathCandidates = (modulePath: string): string[] => {
  const parts = modulePath.split('/').filter(Boolean)
  const candidates: string[] = []
  for (let i = parts.length; i >= 1; i--) {
    candidates.push(parts.slice(0, i).join('/'))
  }
  return candidates
}

const getModuleCachePath = (modCache: string, modulePath: string, version: string): string | null => {
  const escapedVersion = escapeGoModCacheSegment(version)

  for (const candidatePath of getModulePathCandidates(modulePath)) {
    const escapedPath = candidatePath.split('/').map(escapeGoModCacheSegment).join('/')
    const parts = escapedPath.split('/')
    const last = parts.pop() as string
    const baseDir = join(modCache, ...parts)
    if (!existsSync(baseDir)) continue

    if (version && version !== 'latest') {
      const candidate = join(baseDir, `${last}@${escapedVersion}`)
      if (existsSync(candidate)) return candidate

      // For commit hashes and other non-semver refs, Go often stores a pseudo-version
      // (for example: v0.0.0-<timestamp>-<commit>) in module cache.
      try {
        const entries = readdirSync(baseDir)
        const matching = entries.filter((e) => {
          if (!e.startsWith(last + '@')) return false
          return e.endsWith(`-${escapedVersion}`) || e.includes(escapedVersion)
        })

        let best: string | null = null
        let bestMtime = 0
        for (const e of matching) {
          const p = join(baseDir, e)
          let st
          try { st = statSync(p) } catch { continue }
          const mtime = st.mtimeMs
          if (mtime > bestMtime) {
            bestMtime = mtime
            best = p
          }
        }
        if (best) return best
      } catch (_) {
        // continue with next candidate path
      }
    }

    // version == 'latest' or unspecified: find the most recently modified matching dir
    try {
      const entries = readdirSync(baseDir)
      let best: string | null = null
      let bestMtime = 0
      for (const e of entries) {
        if (!e.startsWith(last + '@')) continue
        const p = join(baseDir, e)
        let st
        try { st = statSync(p) } catch { continue }
        const mtime = st.mtimeMs
        if (mtime > bestMtime) {
          bestMtime = mtime
          best = p
        }
      }
      if (best) return best
    } catch (_) {
      // continue with the next shorter candidate path
    }
  }

  return null
}

const collectDeclarationFiles = (dir: string, depth = 0, maxDepth = 4): string[] => {
  if (depth > maxDepth) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (_) {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch (_) {
      continue
    }

    if (st.isDirectory()) {
      out.push(...collectDeclarationFiles(full, depth + 1, maxDepth))
      continue
    }

    if (st.isFile() && isDeclarationFile(entry)) {
      out.push(full)
    }
  }

  return out
}

const copyDtsFile = (srcPath: string, destDir: string, rewriteModuleSpecifier?: string) => {
  const name = basename(srcPath)
  const targetPath = join(destDir, name)

  if (!rewriteModuleSpecifier) {
    copyFileSync(srcPath, targetPath)
    return
  }

  try {
    const content = readFileSync(srcPath, 'utf8')
    const rewritten = content.replace(
      /(declare\s+module\s+['\"])go:[^'\"]+(['\"]\s*\{)/,
      `$1${rewriteModuleSpecifier}$2`
    )
    writeFileSync(targetPath, rewritten, 'utf8')
  } catch (_) {
    // Fall back to plain copy if rewriting fails for any reason.
    copyFileSync(srcPath, targetPath)
  }
}

const ensureTypesPackageEntry = (dtsDir: string) => {
  const normalized = dtsDir.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/@types/')) {
    return
  }

  let files: string[]
  try {
    files = readdirSync(dtsDir)
      .filter((f) => f.endsWith('.d.ts') && f !== 'index.d.ts')
      .sort()
  } catch (_) {
    return
  }

  if (files.length === 0) {
    return
  }

  const refs = files.map((f) => `/// <reference path="./${f}" />`).join('\n')
  writeFileSync(join(dtsDir, 'index.d.ts'), `${refs}\nexport {}\n`, 'utf8')
}

export const buildFile: GoBuilder = (viteConfig, config, id): Promise<string> => {
  const cleanId = stripQuery(id)
  if (!config.goBinaryPath) {
    return Promise.reject(new Error('goBinaryPath must be set in config (should be resolved by the plugin setup)'))
  }
  const goBinExe = config.goBinaryPath
  // quick availability check
  try {
    const check = spawnSync(goBinExe, ['version'])
    if (check.error) {
      throw check.error
    }
  } catch (err) {
    return Promise.reject(new Error(`go binary not found at ${goBinExe}: ${String(err)}`))
  }

  const isLocalTarget = cleanId.startsWith(GO_LOCAL_ID_PREFIX)
  const isRemoteTarget = cleanId.startsWith(GO_REMOTE_ID_PREFIX)

  if (!isLocalTarget && !isRemoteTarget) {
    return Promise.reject(new Error(`unsupported go target: ${id}`))
  }

  // Query all needed Go env vars in one call; prefer values already set in process.env.
  const goEnv = queryGoEnv(goBinExe)

  const packageDir = isLocalTarget ? cleanId.slice(GO_LOCAL_ID_PREFIX.length) : ''
  const fileDir = isLocalTarget ? packageDir : process.cwd()
  const moduleRoot = isLocalTarget ? findModuleRoot(packageDir) : null

  const projectRoot = viteConfig.root || process.cwd()

  let goBuildDir = config.goBuildDir as string
  // relative dirs are resolved against the Vite project root, not the nested Go module root
  if (goBuildDir && !isAbsolute(goBuildDir)) {
    goBuildDir = join(projectRoot, goBuildDir)
  }

  let goDtsDir = (config.goDtsDir || goBuildDir) as string
  if (goDtsDir && !isAbsolute(goDtsDir)) {
    goDtsDir = join(projectRoot, goDtsDir)
  }
  const goBinDir =
    (config.goBin &&
      (isAbsolute(config.goBin as string)
        ? (config.goBin as string)
        : join(projectRoot, config.goBin as string))) ||
    join(goBuildDir as string, 'bin')
  mkdirSync(goBuildDir, { recursive: true })
  mkdirSync(goBinDir, { recursive: true })
  if (config.copyDts !== false) {
    mkdirSync(goDtsDir, { recursive: true })
  }

  const envBase: any = {
    ...process.env,
    GOPATH:    process.env.GOPATH    || goEnv.GOPATH    || undefined,
    GOROOT:    process.env.GOROOT    || goEnv.GOROOT    || undefined,
    GOCACHE:   process.env.GOCACHE   || goEnv.GOCACHE   || undefined,
    GOMODCACHE: process.env.GOMODCACHE || goEnv.GOMODCACHE || undefined,
    GOOS: 'js',
    GOARCH: 'wasm'
  }

  // debug info: show what we're about to build
  try {
    viteConfig.logger.info(
      `[go-build] request id=${id} cleanId=${cleanId} fileDir=${fileDir} moduleRoot=${moduleRoot} goBuildDir=${goBuildDir} goBinDir=${goBinDir}`
    )
  } catch (_) {}

  if (isLocalTarget && !moduleRoot) {
    return Promise.reject(new Error(`no go.mod found for local go package: ${packageDir}`))
  }

  if (moduleRoot && isLocalTarget) {
    // local module: build package relative to moduleRoot
    const relPkg = relative(moduleRoot, packageDir)
    const pkgArg = relPkg === '' ? '.' : './' + relPkg.replace(/\\/g, '/')
    const relFromRoot = relative(projectRoot, packageDir)
    const outputName = `${relFromRoot.replace(/\\/g, '/')}.wasm`
    const outputPath = join(goBuildDir as string, outputName)
    mkdirSync(dirname(outputPath), { recursive: true })
    const args = ['build', ...(config.goArgs || []), '-o', outputPath, pkgArg]

    // Run build in the package directory to ensure go finds the correct go.mod
    const cwd = packageDir

    try { viteConfig.logger.info(`[go-build] local build cmd=${goBinExe} args=${JSON.stringify(args)} cwd=${cwd}`) } catch (_) {}

    const child = execFile(goBinExe, args, { cwd, env: envBase }, (err, stdout, stderr) => {
      if (err != null) {
        viteConfig.logger.error('[go-build] local build error: ' + String(err))
      }
      if (stdout) viteConfig.logger.info(stdout)
      if (stderr) viteConfig.logger.error(stderr)
    })

    return new Promise((resolve, reject) => {
      child.once('exit', (code) => {
        if (code !== 0) return reject(new Error(`builder exit with code: ${code}`))
        // copy .d.ts files if requested
        if (config.copyDts !== false) {
          try {
            const files = readdirSync(packageDir).filter(f => f.endsWith('.d.ts'))
            for (const f of files) {
              copyDtsFile(join(packageDir, f), goDtsDir)
            }
            ensureTypesPackageEntry(goDtsDir)
          } catch (_) {}
        }
        resolve(outputPath)
      })
      child.once('error', (err) => reject(err))
    })
  }

  // remote module flow
  // id could be 'module/path@version' or 'module/path' or a local path — attempt to map
  const requestedRemoteSpecifier = cleanId.slice(GO_REMOTE_ID_PREFIX.length)
  let moduleRef = requestedRemoteSpecifier
  // ensure version
  if (!moduleRef.includes('@')) moduleRef = moduleRef + '@latest'
  const modulePathOnly = moduleRef.split('@')[0]
  const moduleCmdName = modulePathOnly.split('/').pop() || 'module'

  // Cross-compiled `go install` cannot run with GOBIN set.
  // Force a deterministic install location under goBuildDir via GOPATH/bin/js_wasm.
  const remoteWasmDir = join(goBuildDir as string, 'bin', 'js_wasm')
  mkdirSync(remoteWasmDir, { recursive: true })
  const envRemote: any = {
    ...envBase,
    GOPATH: goBuildDir,
    GOBIN: undefined
  }

  // record existing build artifacts to detect newly installed outputs
  const before = new Set(listBuildArtifacts(remoteWasmDir))

  const installArgs = ['install', ...(config.goArgs || []), moduleRef]
  try { viteConfig.logger.info(`[go-build] remote install cmd=${goBinExe} args=${JSON.stringify(installArgs)} cwd=${process.cwd()}`) } catch (_) {}

  const child = execFile(goBinExe, installArgs, { cwd: process.cwd(), env: envRemote }, (err, stdout, stderr) => {
    if (err != null) viteConfig.logger.error('[go-build] remote install error: ' + String(err))
    if (stdout) viteConfig.logger.info(stdout)
    if (stderr) viteConfig.logger.error(stderr)
  })

  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`go install exit with code: ${code}`))
      // find newly installed artifact in cross-compiled install dir
      const after = listBuildArtifacts(remoteWasmDir)
      const added = after.filter(f => !before.has(f))
      if (added.length > 0) {
        const preferred = added.find(f => f === moduleCmdName)
          || added.find(f => f === `${moduleCmdName}.wasm`)
          || added.find(f => f.endsWith('.wasm'))
          || added[0]
        const found = join(remoteWasmDir, preferred)
        // copy d.ts from module cache if requested
        if (config.copyDts !== false) {
          try {
            const modCache = envBase.GOMODCACHE || goEnv.GOMODCACHE
            const [modPath, ver] = moduleRef.split('@')
            const version = ver || 'latest'
            const cachePath = getModuleCachePath(modCache, modPath, version)
            if (cachePath && existsSync(cachePath)) {
              const dts = collectDeclarationFiles(cachePath, 0, 2)
              if (dts.length === 0) {
                try {
                  viteConfig.logger.warn(`[go-build] no .d.ts found in module cache: ${cachePath}`)
                } catch (_) {}
              }
              for (const srcPath of dts) copyDtsFile(srcPath, goDtsDir, `go:${requestedRemoteSpecifier}`)
              ensureTypesPackageEntry(goDtsDir)
            } else {
              try {
                viteConfig.logger.warn(`[go-build] module cache path not found for ${moduleRef}`)
              } catch (_) {}
            }
          } catch (_) {}
        }
        resolve(found)
      } else {
        // fallback: resolve to likely output names under js_wasm dir
        const fallbackNoExt = join(remoteWasmDir, moduleCmdName)
        const fallbackWasm = join(remoteWasmDir, moduleCmdName + '.wasm')
        // attempt to copy d.ts from module cache even if wasm not detected
        if (config.copyDts !== false) {
          try {
            const modCache = envBase.GOMODCACHE || goEnv.GOMODCACHE
            const [modPath, ver] = moduleRef.split('@')
            const version = ver || 'latest'
            const cachePath = getModuleCachePath(modCache, modPath, version)
            if (cachePath && existsSync(cachePath)) {
              const dts = collectDeclarationFiles(cachePath, 0, 2)
              if (dts.length === 0) {
                try {
                  viteConfig.logger.warn(`[go-build] no .d.ts found in module cache: ${cachePath}`)
                } catch (_) {}
              }
              for (const srcPath of dts) copyDtsFile(srcPath, goDtsDir, `go:${requestedRemoteSpecifier}`)
              ensureTypesPackageEntry(goDtsDir)
            } else {
              try {
                viteConfig.logger.warn(`[go-build] module cache path not found for ${moduleRef}`)
              } catch (_) {}
            }
          } catch (_) {}
        }
        resolve(existsSync(fallbackNoExt) ? fallbackNoExt : fallbackWasm)
      }
    })
    child.once('error', (err) => reject(err))
  })
}
