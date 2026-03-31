import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { extname, join, relative, dirname, parse } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { GoBuilder } from './interface.js'

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

  const fileDir = dirname(id)
  const moduleRoot = findModuleRoot(fileDir)

  const goBuildDir = config.goBuildDir as string
  const goBinDir = config.goBin || join(goBuildDir, 'bin')
  mkdirSync(goBuildDir, { recursive: true })
  mkdirSync(goBinDir, { recursive: true })

  const envBase: any = {
    ...process.env,
    GOPATH: process.env.GOPATH,
    GOROOT: process.env.GOROOT,
    GOCACHE: join(goBuildDir, '.gocache'),
    GOBIN: goBinDir,
    GOOS: 'js',
    GOARCH: 'wasm'
  }

  if (moduleRoot) {
    // local module: build package relative to moduleRoot
    const relPkg = relative(moduleRoot, fileDir)
    const pkgArg = relPkg === '' ? '.' : './' + relPkg.replace(/\\/g, '/')
    const outputPath = join(goBuildDir, relative(process.cwd(), id.replace(extname(id), '') + '.wasm'))
    const args = ['build', ...(config.goBuildExtraArgs || []), '-o', outputPath, pkgArg]

    const child = execFile(goBinExe, args, { cwd: moduleRoot, env: envBase }, (err, stdout, stderr) => {
      if (err != null) {
        viteConfig.logger.error(String(err))
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
  let moduleRef = id
  // if id ends with .go, try to strip path and treat as module@latest
  if (id.endsWith('.go')) {
    // fallback: try to interpret as module path without file
    const parts = id.split('/')
    // remove trailing file
    parts.pop()
    moduleRef = parts.join('/')
  }
  // ensure version
  if (!moduleRef.includes('@')) moduleRef = moduleRef + '@latest'

  // record existing wasm files in goBinDir to detect new ones
  const before = new Set(listWasmFiles(goBinDir))

  const installArgs = ['install', ...(config.goInstallArgs || []), moduleRef]
  const child = execFile(goBinExe, installArgs, { cwd: process.cwd(), env: envBase }, (err, stdout, stderr) => {
    if (err != null) viteConfig.logger.error(String(err))
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
