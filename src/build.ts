import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { extname, join, relative, dirname, parse, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { GoBuilder } from './interface.js'

const stripQuery = (id: string) => id.split('?')[0].split('#')[0]

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

const getModuleCachePath = (modCache: string, modulePath: string, version: string): string | null => {
  const parts = modulePath.split('/')
  const last = parts.pop() as string
  const baseDir = join(modCache, ...parts)
  if (!existsSync(baseDir)) return null

  if (version && version !== 'latest') {
    const candidate = join(baseDir, `${last}@${version}`)
    if (existsSync(candidate)) return candidate
    return null
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
    return best
  } catch (_){
    return null
  }
}

export const buildFile: GoBuilder = (viteConfig, config, id): Promise<string> => {
  const cleanId = stripQuery(id)
  const goBinExe = config.goBinaryPath || 'go'
  // quick availability check
  try {
    const check = spawnSync(goBinExe, ['version'])
    if (check.error) {
      throw check.error
    }
  } catch (err) {
    return Promise.reject(new Error(`go binary not found at ${goBinExe}: ${String(err)}`))
  }

  const fileDir = dirname(cleanId)
  const moduleRoot = findModuleRoot(fileDir)

  let goBuildDir = config.goBuildDir as string
  // if configured build dir is relative and we have a module root, resolve it inside the module
  if (goBuildDir && !isAbsolute(goBuildDir) && moduleRoot) {
    goBuildDir = join(moduleRoot, goBuildDir)
  }
  const goBinDir = (config.goBin && (isAbsolute(config.goBin as string) ? config.goBin as string : (moduleRoot ? join(moduleRoot, config.goBin as string) : join(process.cwd(), config.goBin as string)))) || join(goBuildDir as string, 'bin')
  mkdirSync(goBuildDir, { recursive: true })
  mkdirSync(goBinDir, { recursive: true })

  const envBase: any = {
    ...process.env,
    GOPATH: process.env.GOPATH,
    GOROOT: process.env.GOROOT,
    GOCACHE: process.env.GOCACHE, //join(goBuildDir, '.gocache'),
    GOBIN: goBinDir,
    GOOS: 'js',
    GOARCH: 'wasm'
  }

  // debug info: show what we're about to build
  try {
    viteConfig.logger.info(
      `[go-build] request id=${id} cleanId=${cleanId} fileDir=${fileDir} moduleRoot=${moduleRoot} goBuildDir=${goBuildDir} goBinDir=${goBinDir}`
    )
  } catch (_) {}

  if (moduleRoot) {
    // local module: build package relative to moduleRoot
    const relPkg = relative(moduleRoot, fileDir)
    const pkgArg = relPkg === '' ? '.' : './' + relPkg.replace(/\\/g, '/')
    const outputPath = join(goBuildDir as string, relative(moduleRoot, cleanId.replace(extname(cleanId), '') + '.wasm'))
    const args = ['build', ...(config.goBuildExtraArgs || []), '-o', outputPath, pkgArg]

    // Run build in the package directory to ensure go finds the correct go.mod
    const cwd = fileDir

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
        // copy .go.d.ts files if requested
        if (config.copyDts !== false) {
          try {
            const files = readdirSync(fileDir).filter(f => f.endsWith('.go.d.ts'))
            for (const f of files) {
              copyFileSync(join(fileDir, f), join(dirname(outputPath), f))
            }
          } catch (_) {}
        }
        resolve(outputPath)
      })
      child.once('error', (err) => reject(err))
    })
  }

  // remote module flow
  // id could be 'module/path@version' or 'module/path' or a local path — attempt to map
  let moduleRef = cleanId
  // if id ends with .go, try to strip path and treat as module@latest
  if (cleanId.endsWith('.go')) {
    // fallback: try to interpret as module path without file
    const parts = cleanId.split('/')
    // remove trailing file
    parts.pop()
    moduleRef = parts.join('/')
  }
  // ensure version
  if (!moduleRef.includes('@')) moduleRef = moduleRef + '@latest'

  // record existing wasm files in goBinDir to detect new ones
  const before = new Set(listWasmFiles(goBinDir))

  const installArgs = ['install', ...(config.goInstallArgs || []), moduleRef]
  try { viteConfig.logger.info(`[go-build] remote install cmd=${goBinExe} args=${JSON.stringify(installArgs)} cwd=${process.cwd()}`) } catch (_) {}

  const child = execFile(goBinExe, installArgs, { cwd: process.cwd(), env: envBase }, (err, stdout, stderr) => {
    if (err != null) viteConfig.logger.error('[go-build] remote install error: ' + String(err))
    if (stdout) viteConfig.logger.info(stdout)
    if (stderr) viteConfig.logger.error(stderr)
  })

  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`go install exit with code: ${code}`))
      // find new wasm in goBinDir
      const after = listWasmFiles(goBinDir)
      const added = after.filter(f => !before.has(f))
      if (added.length > 0) {
        const found = join(goBinDir, added[0])
        // copy d.ts from module cache if requested
        if (config.copyDts !== false) {
          try {
            const modCache = execFileSync(goBinExe, ['env', 'GOMODCACHE']).toString().trim()
            const [modPath, ver] = moduleRef.split('@')
            const version = ver || 'latest'
            const cachePath = getModuleCachePath(modCache, modPath, version)
            if (cachePath && existsSync(cachePath)) {
              const dts = readdirSync(cachePath).filter(f => f.endsWith('.go.d.ts'))
              for (const f of dts) copyFileSync(join(cachePath, f), join(goBinDir, f))
            }
          } catch (_) {}
        }
        resolve(found)
      } else {
        // fallback: if no wasm found, resolve to path under goBinDir named after module
        const fallbackName = moduleRef.split('/').pop() || 'module'
        // attempt to copy d.ts from module cache even if wasm not detected
        if (config.copyDts !== false) {
          try {
            const modCache = execFileSync(goBinExe, ['env', 'GOMODCACHE']).toString().trim()
            const [modPath, ver] = moduleRef.split('@')
            const version = ver || 'latest'
            const cachePath = getModuleCachePath(modCache, modPath, version)
            if (cachePath && existsSync(cachePath)) {
              const dts = readdirSync(cachePath).filter(f => f.endsWith('.go.d.ts'))
              for (const f of dts) copyFileSync(join(cachePath, f), join(goBinDir, f))
            }
          } catch (_) {}
        }
        resolve(join(goBinDir, fallbackName + '.wasm'))
      }
    })
    child.once('error', (err) => reject(err))
  })
}
