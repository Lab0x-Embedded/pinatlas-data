// Disk layer: incremental writes (only touch files whose bytes actually changed), index shards,
// manifest and meta.
//
// Files are written as compact JSON (one line, trailing newline): 2952 files measure 34 MB
// compact vs roughly double that pretty-printed, and the frontend fetches one small file per
// chip anyway (2.4 KB gzipped on average), so pretty-printing buys nothing but repo weight.
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export const jsonText = (obj) => JSON.stringify(obj) + '\n'

export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** Write only when the bytes differ — keeps weekly commits limited to real changes. */
export async function writeIfChanged(path, text) {
  const current = await readTextIfExists(path)
  if (current === text) return 'unchanged'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return current === null ? 'added' : 'updated'
}

export async function writeAlways(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function walkJson(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return out
    throw err
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkJson(p)))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

/**
 * Rebuild index shards from the whole data tree (not just this run's files), so an incremental
 * sync never leaves the index claiming less than what is on disk.
 */
export async function rebuildIndex({ outDir, indexPath, manifestPath, vendorSlug, generatedAt, upstream }) {
  const root = join(outDir, vendorSlug)
  const files = (await walkJson(root)).sort()
  const shards = new Map()
  let chipCount = 0
  let pinCount = 0
  let afCount = 0
  let afSlots = 0

  for (const file of files) {
    let doc
    try {
      doc = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    chipCount++
    pinCount += doc.pinCount || 0
    for (const pin of doc.pins || []) {
      for (const fn of pin.functions || []) {
        if (fn.system) continue
        afSlots++
        if (typeof fn.af === 'number') afCount++
      }
    }
    const family = doc.family || 'unknown'
    if (!shards.has(family)) shards.set(family, { family, count: 0, path: '', chips: [] })
    const shard = shards.get(family)
    shard.count++
    shard.chips.push({
      chip: doc.chip,
      displayName: doc.displayName ?? doc.chip,
      line: doc.line ?? null,
      die: doc.die ?? null,
      package: doc.package ?? null,
      packageKind: doc.packageKind ?? null,
      pinCount: doc.pinCount ?? null,
      flashKb: doc.memory?.flashKb ?? null,
      part: `${vendorSlug}/${family}/${doc.chip}.json`
    })
  }

  const shardMeta = []
  for (const [family, shard] of [...shards].sort(([a], [b]) => a.localeCompare(b))) {
    shard.chips.sort((a, b) =>
      String(a.line).localeCompare(String(b.line)) || String(a.chip).localeCompare(String(b.chip)))
    const path = `${vendorSlug}/${family}.json`
    await writeAlways(join(indexPath, path), jsonText({
      schemaVersion: '1.1.0',
      family,
      count: shard.count,
      generatedAt,
      chips: shard.chips
    }))
    shardMeta.push({ family, count: shard.count, path: `index/${path}` })
  }

  const manifest = {
    schemaVersion: '1.1.0',
    generatedAt,
    vendor: vendorSlug,
    upstream,
    totals: {
      chips: chipCount,
      pins: pinCount,
      afSlots,
      afCoverage: afSlots ? Number((afCount / afSlots).toFixed(4)) : 0
    },
    shards: shardMeta
  }
  await writeAlways(manifestPath, jsonText(manifest))
  return manifest
}

export const relPath = (from, to) => relative(from, to).split(sep).join('/')

export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
