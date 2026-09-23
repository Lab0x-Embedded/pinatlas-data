#!/usr/bin/env node
// PinAtlas data sync — LibrePCB/stm-db (primary, per-package pinout) + embassy-rs/stm32-data-generated
// (AF numbers, register/RCC metadata reserved for code generation) → unified JSON under data/.
//
// Design notes that matter operationally:
//   * upstreams are pinned by commit sha resolved at run time (never a branch) — jsDelivr caches
//     branch URLs and would otherwise serve mismatched revisions;
//   * failures never overwrite good data: a chip that fails to download or validate is skipped and
//     listed in meta.json, and the process exits non-zero so CI goes red;
//   * meta.json is always rewritten (checkedAt), which doubles as the weekly heartbeat commit that
//     keeps GitHub's scheduled workflows from being disabled after 60 days of inactivity;
//   * only changed files are written, so a quiet week commits meta.json alone.
//
// Usage:
//   node scripts/sync.mjs                       # full sync (weekly CI job)
//   node scripts/sync.mjs --line STM32F1 --limit 40 --af
//   node scripts/sync.mjs --ref STM32F103C8Tx --af --out /tmp/pinatlas-data-test
//   node scripts/sync.mjs --dry-run --line STM32F1   # convert + validate, write nothing
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchJson, listFiles, resolveRef, mapPool, githubToken, proxyUrl } from './lib/http.mjs'
import { normalizeStmdb, validateUnified, buildAfIndex } from './lib/normalize.mjs'
import { writeIfChanged, writeAlways, rebuildIndex, jsonText } from './lib/write.mjs'

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, short) => argv.includes(`--${name}`) || (short && argv.includes(`-${short}`))
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const pref = argv.find((a) => a.startsWith(`--${name}=`))
  return pref ? pref.slice(name.length + 3) : fallback
}

const opts = {
  line: value('line'),
  ref: value('ref'),
  limit: value('limit') ? Number(value('limit')) : 0,
  af: !flag('no-af'),
  concurrency: value('concurrency') ? Number(value('concurrency')) : null,
  tries: value('tries') ? Number(value('tries')) : null,
  dryRun: flag('dry-run'),
  force: flag('force'),
  useFetch: flag('fetch'),
  quiet: flag('quiet'),
  json: flag('json'),
  out: value('out'),
  primarySha: value('primary-sha'),
  enrichmentSha: value('enrichment-sha'),
  configPath: value('config', join(ROOT, 'config.json'))
}

const config = JSON.parse(await readFile(opts.configPath, 'utf8'))
const net = {
  concurrency: opts.concurrency || config.network.concurrency,
  tries: opts.tries || config.network.tries,
  timeoutMs: config.network.timeoutMs
}
const token = githubToken()
const transport = { tries: net.tries, timeoutMs: net.timeoutMs, token, useFetch: opts.useFetch }
const outDir = pathResolve(ROOT, opts.out || config.output.dir)
const indexPath = join(outDir, 'index')
const startedAt = Date.now()
const log = (...a) => { if (!opts.quiet) console.log(...a) }

log(`pinatlas-data sync → ${outDir}`)
if (proxyUrl()) log(`  transport: curl via proxy ${proxyUrl()}${opts.useFetch ? ' (override: fetch)' : ''}`)
else log(`  transport: ${opts.useFetch ? 'fetch' : 'curl (direct)'}`)

// ── 1. resolve upstream revisions ───────────────────────────────────────────────────────────────
const primary = config.primary
const enrich = config.enrichment

const primaryRev = opts.primarySha
  ? { ref: opts.primarySha, resolved: true, date: null }
  : await resolveRef(primary.repo, primary.branch, transport)
const enrichRev = !opts.af
  ? { ref: null, resolved: false, date: null }
  : (opts.enrichmentSha
      ? { ref: opts.enrichmentSha, resolved: true, date: null }
      : await resolveRef(enrich.repo, enrich.branch, transport))

log(`  primary    ${primary.repo}@${primaryRev.ref}${primaryRev.resolved ? '' : ' (sha unresolved, using branch)'}`)
if (opts.af) log(`  enrichment ${enrich.repo}@${enrichRev.ref}${enrichRev.resolved ? '' : ' (sha unresolved, using branch)'}`)

const cdnFor = (src, ref) => (ref.startsWith('sha256:') ? '' : src.cdn.replace('{ref}', ref))
const fileUrl = (src, ref, path) => {
  const cdn = cdnFor(src, ref)
  return `${cdn}${path}`
}

// ── 2. plan the primary set ─────────────────────────────────────────────────────────────────────
const tree = await listFiles(primary.repo, primaryRev.ref, { prefix: primary.dataPrefix, opts: transport })
if (!tree.ok) {
  console.error(`FATAL: cannot list ${primary.repo}: ${tree.error}`)
  process.exit(2)
}
let planned = tree.files
  .map((f) => ({ ...f, chip: f.path.slice(primary.dataPrefix.length, -5) }))
  .filter((f) => /^STM32/.test(f.chip))
if (opts.ref) planned = planned.filter((f) => f.chip === opts.ref)
if (opts.line) planned = planned.filter((f) => f.chip.startsWith(opts.line))
planned.sort((a, b) => a.chip.localeCompare(b.chip))
if (opts.limit) planned = planned.slice(0, opts.limit)

log(`  primary files: ${planned.length}${opts.line ? ` (line ${opts.line})` : ''}${opts.ref ? ` (ref ${opts.ref})` : ''}${tree.truncated ? ' [tree listing TRUNCATED]' : ''}`)
if (!planned.length) { console.error('FATAL: nothing to sync'); process.exit(2) }

// ── 3. download primary docs ────────────────────────────────────────────────────────────────────
const downloads = await mapPool(planned, net.concurrency, async (f) => {
  const res = await fetchJson(fileUrl(primary, primaryRev.ref, f.path), transport)
  if (!res.ok) throw new Error(`${res.error} (after ${res.attempts} tries)`)
  return { chip: f.chip, path: f.path, doc: res.data }
})

const failures = []
const docs = new Map()
const sourcePath = new Map(planned.map((f) => [f.chip, f.path]))
for (const [i, r] of downloads.entries()) {
  if (r.ok) docs.set(planned[i].chip, r.value.doc)
  else failures.push({ chip: planned[i].chip, stage: 'download-primary', error: r.error })
}
log(`  downloaded: ${docs.size}/${planned.length} (${failures.length} failed)`)

// ── 4. AF enrichment (only the chips actually needed) ───────────────────────────────────────────
const afIndexes = new Map()
const afInfo = { enabled: Boolean(opts.af), chips: 0, bytes: 0, missing: [], chipsMissing: [], skippedForBudget: false }
if (opts.af && docs.size) {
  const wanted = new Map()
  for (const [chip, doc] of docs) {
    const rpn = doc?.names?.rpn || (chip.endsWith('x') ? chip.slice(0, -2) : chip)
    wanted.set(rpn, chip)
  }
  const etree = await listFiles(enrich.repo, enrichRev.ref, { prefix: enrich.dataPrefix, opts: transport })
  if (!etree.ok) {
    afInfo.skippedForBudget = true
    afInfo.missing.push(`*: cannot list enrichment repo (${etree.error})`)
    log(`  enrichment: listing failed (${etree.error}) — continuing without AF`)
  } else {
    const byName = new Map(etree.files.map((f) => [f.path.slice(enrich.dataPrefix.length, -5), f]))
    const picks = []
    let bytes = 0
    for (const [rpn, chip] of wanted) {
      const f = byName.get(rpn)
      if (!f) { afInfo.chipsMissing.push(chip); continue }
      if (bytes + f.size > config.network.afChipBudgetBytes) { afInfo.skippedForBudget = true; break }
      bytes += f.size
      picks.push({ ...f, rpn, chip })
    }
    afInfo.bytes = bytes
    log(`  enrichment: ${picks.length} chip docs, ${(bytes / 1048576).toFixed(1)} MB (${afInfo.chipsMissing.length} not published upstream)`)
    const edl = await mapPool(picks, net.concurrency, async (p) => {
      const res = await fetchJson(fileUrl(enrich, enrichRev.ref, p.path), transport)
      if (!res.ok) throw new Error(`${res.error} (after ${res.attempts} tries)`)
      return { chip: p.chip, doc: res.data }
    })
    for (const [i, r] of edl.entries()) {
      if (!r.ok) { failures.push({ chip: picks[i].chip, stage: 'download-enrichment', error: r.error }); continue }
      afIndexes.set(picks[i].chip, buildAfIndex(r.value.doc))
      afInfo.chips++
    }
  }
}

// ── 5. normalise + validate + write ─────────────────────────────────────────────────────────────
const afMisses = new Set()
const stat = { added: 0, updated: 0, unchanged: 0, skipped: 0, pins: 0, afSlots: 0, afFilled: 0 }
const warnings = []
const perFamily = new Map()
const kept = new Map()

for (const [chip, doc] of docs) {
  const afIndex = afIndexes.get(chip)?.index || null
  let unified
  try {
    unified = normalizeStmdb(doc, {
      ref: chip,
      vendorName: config.output.vendorName,
      afIndex,
      afMisses,
      sourceMeta: {
        primary: { repo: primary.repo, ref: primaryRev.ref, path: sourcePath.get(chip) || null, license: primary.license },
        enrichment: afIndex
          ? { repo: enrich.repo, ref: enrichRev.ref, used: ['af'] }
          : { repo: enrich.repo, ref: enrichRev.ref, used: [] }
      }
    })
  } catch (err) {
    failures.push({ chip, stage: 'normalise', error: err?.message || String(err) })
    stat.skipped++
    continue
  }

  const { errors, warnings: warns } = validateUnified(unified)
  for (const w of warns) warnings.push(`${chip}: ${w}`)
  if (errors.length) {
    failures.push({ chip, stage: 'validate', error: errors.join('; ') })
    stat.skipped++
    continue
  }

  kept.set(chip, unified)
  stat.pins += unified.pinCount
  for (const pin of unified.pins) {
    for (const fn of pin.functions) {
      if (fn.system) continue
      stat.afSlots++
      if (typeof fn.af === 'number') stat.afFilled++
    }
  }
  const fam = unified.family || 'unknown'
  if (!perFamily.has(fam)) perFamily.set(fam, { chips: 0, afSlots: 0, afFilled: 0 })
  const fs = perFamily.get(fam)
  fs.chips++
  for (const pin of unified.pins) {
    for (const fn of pin.functions) {
      if (fn.system) continue
      fs.afSlots++
      if (typeof fn.af === 'number') fs.afFilled++
    }
  }

  if (opts.dryRun) continue
  const target = join(outDir, config.output.vendorSlug, fam, `${chip}.json`)
  const result = await writeIfChanged(target, jsonText(unified))
  stat[result]++
}

// ── 6. index + meta ─────────────────────────────────────────────────────────────────────────────
const upstream = {
  primary: { repo: primary.repo, branch: primary.branch, ref: primaryRev.ref, resolved: primaryRev.resolved, commitDate: primaryRev.date },
  enrichment: opts.af
    ? { repo: enrich.repo, branch: enrich.branch, ref: enrichRev.ref, resolved: enrichRev.resolved, commitDate: enrichRev.date, requested: true }
    : { repo: enrich.repo, requested: false }
}
const generatedAt = new Date().toISOString()

let manifest = null
if (!opts.dryRun) {
  manifest = await rebuildIndex({ outDir, indexPath, manifestPath: join(outDir, 'index.json'), vendorSlug: config.output.vendorSlug, generatedAt, upstream })
}

const meta = {
  schemaVersion: '1.0.0',
  checkedAt: generatedAt,
  generatedAt,
  filters: { line: opts.line, ref: opts.ref, limit: opts.limit || null, af: opts.af },
  upstream,
  run: {
    considered: planned.length,
    written: stat.added + stat.updated,
    added: stat.added,
    updated: stat.updated,
    unchanged: stat.unchanged,
    skipped: stat.skipped,
    failed: failures.length,
    pins: stat.pins,
    afSlots: stat.afSlots,
    afCoverage: stat.afSlots ? Number((stat.afFilled / stat.afSlots).toFixed(4)) : 0,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  },
  enrichment: {
    chips: afInfo.chips,
    megabytes: Number((afInfo.bytes / 1048576).toFixed(1)),
    chipsNotPublishedUpstream: afInfo.chipsMissing.length,
    budgetExceeded: afInfo.skippedForBudget,
    notes: afInfo.missing
  },
  families: [...perFamily].map(([family, s]) => ({
    family,
    chips: s.chips,
    afCoverage: s.afSlots ? Number((s.afFilled / s.afSlots).toFixed(4)) : 0
  })).sort((a, b) => a.family.localeCompare(b.family)),
  datasetTotals: manifest?.totals ?? null,
  failures,
  warningCount: warnings.length,
  warningsTop: [...new Set(warnings)].slice(0, 40),
  afUnmatchedTop: [...afMisses].sort().slice(0, 40)
}

if (!opts.dryRun) {
  await writeAlways(join(outDir, 'meta.json'), jsonText(meta))
} else {
  meta.datasetTotals = { dryRun: true, chips: kept.size, pins: stat.pins }
}

const summary = {
  ok: failures.length === 0,
  ...meta.run,
  afCoverage: meta.run.afCoverage,
  failures: failures.slice(0, 10)
}

if (opts.json) console.log(JSON.stringify(summary, null, 2))
else {
  log(`\nwritten: ${stat.added} added, ${stat.updated} updated, ${stat.unchanged} unchanged, ${stat.skipped} skipped, ${failures.length} failed`)
  log(`pins: ${stat.pins} | AF filled: ${stat.afFilled}/${stat.afSlots} (${(meta.run.afCoverage * 100).toFixed(1)}%)`)
  if (manifest) log(`dataset now: ${manifest.totals.chips} chips, ${manifest.totals.pins} pins, AF ${(manifest.totals.afCoverage * 100).toFixed(1)}%`)
  if (afMisses.size) log(`AF 未匹配 token（前 10）: ${[...afMisses].sort().slice(0, 10).join(', ')}`)
  if (warnings.length) log(`warnings: ${warnings.length} (see meta.json)`)
  for (const f of failures.slice(0, 10)) log(`  FAIL ${f.chip} [${f.stage}] ${f.error}`)
  log(`done in ${meta.run.seconds}s`)
}

process.exit(failures.length ? 1 : 0)
