import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function discoverDshAnchors(ctx) {
  const anchors = []
  const installAnchor = ctx?.get?.('profileContext')?.installAnchor
  if (typeof installAnchor === 'string' && installAnchor.length > 0) {
    anchors.push(installAnchor)
  }
  if (typeof process.env.DSH_RUNTIME_ROOT === 'string' && process.env.DSH_RUNTIME_ROOT.length > 0) {
    anchors.push(join(process.env.DSH_RUNTIME_ROOT, 'package.json'))
  }
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
    anchors.push(process.argv[1])
  }
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  try {
    const dshBin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    if (dshBin) {
      const real = realpathSync(dshBin)
      let cur = dirname(real)
      for (let i = 0; i < 6; i++) {
        const pkgJson = join(cur, 'package.json')
        if (existsSync(pkgJson)) anchors.push(pkgJson)
        const parent = dirname(cur)
        if (parent === cur) break
        cur = parent
      }
    }
  } catch {}

  const reqs = [createRequire(import.meta.url)]
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      reqs.push(req)
      for (const bridge of [
        '@deepseek-ai/dsh-app-boot/package.json',
        '@deepseek-ai/dsh-web-app/package.json',
        '@deepseek-ai/dsh-base/package.json',
      ]) {
        try {
          reqs.push(createRequire(req.resolve(bridge)))
        } catch {}
      }
    } catch {}
  }
  return reqs
}

export async function importDshPackage(specifier, ctx) {
  try {
    return await import(specifier)
  } catch {
    for (const req of discoverDshAnchors(ctx)) {
      try {
        const resolved = req.resolve(specifier)
        return await import(pathToFileURL(resolved).href)
      } catch {}
    }
    throw new Error(`Unable to resolve DSH runtime package: ${specifier}`)
  }
}
