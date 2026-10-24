// Disk layer: incremental writes (only touch files whose bytes actually changed), index shards,
// manifest and meta.
//
// Files are written as compact JSON (one line, trailing newline): 2952 files measure 34 MB
// compact vs roughly double that pretty-printed, and the frontend fetches one small file per
// chip anyway (2.4 KB gzipped on average), so pretty-printing buys nothing but repo weight.
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import { SCHEMA_VERSION } from './normalize.mjs'

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
 *
 * Multi-vendor: every vendor directory under outDir gets its own shard set and its own section
 * in the manifest. The legacy top-level fields (vendor/upstream/totals/shards) keep mirroring
 * the `st` section when it was synced this run — the pre-multi-vendor frontend contract — and
 * fall back to the first vendor otherwise. Vendors whose data exists on disk but was not part
 * of this run carry `upstream: null` (their docs are still indexed, just without fresh refs).
 */
async function buildVendorIndex({ outDir, indexPath, vendorSlug, vendorName, generatedAt, upstream }) {
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
    // Defence against stray JSON under the vendor tree: only chip documents count.
    if (!doc || !Array.isArray(doc.pins) || typeof doc.chip !== 'string') continue
    chipCount++
    pinCount += doc.pinCount || 0
    const mpns = [...new Set((doc.parts || []).map((p) => p?.mpn).filter(Boolean))]
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
      // 订货号（parts[].mpn，v1.3.0 起）：用户常按芯片丝印搜（"STM32F103C8T6" / "C8T6"），
      // 而 chip id 是带通配后缀的 ref（STM32F103C8Tx），只靠 chip/displayName 搜不到。
      // 实测 2737/2781 型号有 mpn，全库 5034 条（平均 1.8、最多 8），索引只涨 83 KB。
      ...(mpns.length ? { mpns } : {}),
      part: `${vendorSlug}/${family}/${doc.chip}.json`
    })
  }

  const shardMeta = []
  for (const [family, shard] of [...shards].sort(([a], [b]) => a.localeCompare(b))) {
    shard.chips.sort((a, b) =>
      String(a.line).localeCompare(String(b.line)) || String(a.chip).localeCompare(String(b.chip)))
    const path = `${vendorSlug}/${family}.json`
    await writeAlways(join(indexPath, path), jsonText({
      schemaVersion: SCHEMA_VERSION,
      family,
      count: shard.count,
      generatedAt,
      chips: shard.chips
    }))
    shardMeta.push({ family, count: shard.count, path: `index/${path}` })
  }

  return {
    vendor: vendorSlug,
    vendorName: vendorName ?? vendorSlug,
    upstream: upstream ?? null,
    totals: {
      chips: chipCount,
      pins: pinCount,
      afSlots,
      afCoverage: afSlots ? Number((afCount / afSlots).toFixed(4)) : 0
    },
    // afCount rides along for multi-vendor aggregation; the legacy top-level `totals`
    // deliberately keeps the pre-v1.4.0 {chips,pins,afSlots,afCoverage} shape.
    afCount,
    shards: shardMeta
  }
}

/**
 * @param {string[]} vendorSlugs vendor sections to (re)build; data dirs found on disk but not
 *   listed here are indexed too, with `upstream: null`.
 */
export async function rebuildIndex({ outDir, indexPath, manifestPath, vendorSlugs, vendorNames, upstreams, generatedAt }) {
  // Vendor dirs present on disk (a partial --vendor run must not drop the others from the
  // index). The index directory itself lives under outDir and must not become a phantom vendor.
  let diskSlugs = []
  try {
    const indexDirName = basename(indexPath || 'index')
    diskSlugs = (await readdir(outDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== indexDirName)
      .map((e) => e.name)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const all = [...new Set([...vendorSlugs, ...diskSlugs])]

  const sections = new Map()
  for (const slug of all) {
    sections.set(slug, await buildVendorIndex({
      outDir, indexPath, vendorSlug: slug,
      vendorName: vendorNames?.[slug],
      generatedAt,
      upstream: upstreams?.[slug] ?? null
    }))
  }

  // Legacy top-level mirror: st while it exists, else the first section.
  const legacy = sections.get('st') ?? [...sections.values()][0]
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    vendor: legacy.vendor,
    upstream: legacy.upstream,
    totals: legacy.totals,
    shards: legacy.shards,
    vendors: Object.fromEntries([...sections].sort(([a], [b]) => a.localeCompare(b)))
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
