#!/usr/bin/env node
// PinAtlas data sync — multi-vendor orchestrator.
//   st:        LibrePCB/stm-db (primary, per-package pinout) + embassy-rs/stm32-data-generated
//              (AF numbers) → unified JSON under data/st/.
//   espressif: esp-idf headers (pad/IOMUX/GPIO-matrix signal maps) + curated package overlays
//              → unified JSON under data/espressif/. (see scripts/lib/sources/espidf.mjs)
//
// Design notes that matter operationally:
//   * each vendor is a source adapter (scripts/lib/sources/<source>.mjs) with the same
//     contract: resolve upstreams → download → normalise + validate → unified docs. Everything
//     vendor-specific stays there; this file owns stats, writing, index and meta;
//   * upstreams are pinned by commit sha / release tag resolved at run time (never a branch) —
//     jsDelivr caches branch URLs and would otherwise serve mismatched revisions;
//   * failures never overwrite good data: a chip that fails to download or validate is skipped
//     and listed in meta.json, and the process exits non-zero so CI goes red;
//   * meta.json is always rewritten (checkedAt), which doubles as the weekly heartbeat commit
//     that keeps GitHub's scheduled workflows from being disabled after 60 idle days;
//   * only changed files are written, so a quiet week commits meta.json alone.
//
// Usage:
//   node scripts/sync.mjs                                  # all configured vendors
//   node scripts/sync.mjs --vendor st --line STM32F1 --limit 40 --af
//   node scripts/sync.mjs --vendor espressif --ref ESP32-C3 --dry-run
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { githubToken, proxyUrl } from './lib/http.mjs'
import { VALIDATION_RULES, SCHEMA_VERSION } from './lib/normalize.mjs'
import { writeIfChanged, writeAlways, rebuildIndex, jsonText } from './lib/write.mjs'
import { run as runStmdb } from './lib/sources/stmdb.mjs'
import { run as runEspidf } from './lib/sources/espidf.mjs'

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCES = { stmdb: runStmdb, espidf: runEspidf }

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
  vendor: value('vendor', 'all'),
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

const selected = opts.vendor === 'all' ? Object.keys(config.vendors) : opts.vendor.split(',')
for (const slug of selected) {
  if (!config.vendors[slug]) { console.error(`FATAL: unknown vendor "${slug}" (configured: ${Object.keys(config.vendors).join(', ')})`); process.exit(2) }
  if (!SOURCES[config.vendors[slug].source]) { console.error(`FATAL: source adapter "${config.vendors[slug].source}" for vendor ${slug} is not registered`); process.exit(2) }
}

log(`pinatlas-data sync → ${outDir}`)
if (proxyUrl()) log(`  transport: curl via proxy ${proxyUrl()}${opts.useFetch ? ' (override: fetch)' : ''}`)
else log(`  transport: ${opts.useFetch ? 'fetch' : 'curl (direct)'}`)

// ── per-vendor run + shared stats/write loop ─────────────────────────────────────────────────────
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
const vendorResults = new Map() // slug → {res, stat, pinTypes, functionTypes, aliasedPins, perFamily}

for (const slug of selected) {
  if (selected.length > 1) log(`\n── vendor ${slug} (${config.vendors[slug].source}) ──`)
  const res = await SOURCES[config.vendors[slug].source]({
    vendorSlug: slug,
    vendorCfg: config.vendors[slug],
    config,
    opts,
    transport,
    net,
    log
  })
  if (res.fatal) {
    // A line/ref filter that matches nothing in ONE vendor must not abort a multi-vendor run
    // (STM32F1 filters out every ESP32); an empty plan without filters is still fatal.
    if (res.fatal.endsWith('nothing to sync') && (opts.line || opts.ref) && selected.length > 1) {
      log(`  ${res.fatal.replace('FATAL: ', '')} — vendor ${slug} skipped`)
      continue
    }
    console.error(res.fatal)
    process.exit(2)
  }

  const stat = { added: 0, updated: 0, unchanged: 0, skipped: res.skipped ?? 0, pins: 0, afSlots: 0, afFilled: 0 }
  const perFamily = new Map()
  const pinTypes = new Map()
  const functionTypes = new Map()
  let aliasedPins = 0

  for (const [chip, unified] of res.docs) {
    stat.pins += unified.pinCount
    for (const pin of unified.pins) {
      bump(pinTypes, pin.type)
      if (pin.aliases?.length) aliasedPins++
      for (const fn of pin.functions) {
        bump(functionTypes, fn.type ?? 'unknown')
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
    const target = join(outDir, slug, fam, `${chip}.json`)
    const result = await writeIfChanged(target, jsonText(unified))
    stat[result]++
  }

  vendorResults.set(slug, { res, stat, pinTypes, functionTypes, aliasedPins, perFamily })
}

// ── index + meta ─────────────────────────────────────────────────────────────────────────────────
const generatedAt = new Date().toISOString()

let manifest = null
if (!opts.dryRun) {
  manifest = await rebuildIndex({
    outDir,
    indexPath,
    manifestPath: join(outDir, 'index.json'),
    vendorSlugs: selected,
    vendorNames: Object.fromEntries(selected.map((s) => [s, config.vendors[s].vendorName])),
    upstreams: Object.fromEntries([...vendorResults].map(([s, { res }]) => [s, res.upstream])),
    generatedAt
  })
}

// st-run semantics (afSlots etc.) aggregate naturally across vendors: ESP32 reuses `af` for the
// IOMUX function-select value, so "slots with a mux select" stays a meaningful global ratio.
const totals = { considered: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, pins: 0, afSlots: 0, afFilled: 0 }
const allFailures = []
const allWarnings = []
const pinTypes = new Map()
const functionTypes = new Map()
let aliasedPins = 0
const afUnmatched = new Set()

const vendorSections = {}
for (const [slug, { res, stat, pinTypes: pt, functionTypes: ft, aliasedPins: ap, perFamily }] of vendorResults) {
  totals.considered += res.considered
  for (const k of ['added', 'updated', 'unchanged', 'skipped']) totals[k] += stat[k]
  totals.failed += res.failures.length
  totals.pins += stat.pins
  totals.afSlots += stat.afSlots
  totals.afFilled += stat.afFilled
  allFailures.push(...res.failures)
  allWarnings.push(...res.warnings)
  for (const [k, v] of pt) pinTypes.set(k, (pinTypes.get(k) ?? 0) + v)
  for (const [k, v] of ft) functionTypes.set(k, (functionTypes.get(k) ?? 0) + v)
  aliasedPins += ap
  for (const m of res.afMisses ?? []) afUnmatched.add(m)

  vendorSections[slug] = {
    vendorName: config.vendors[slug].vendorName,
    upstream: res.upstream,
    run: {
      considered: res.considered,
      written: stat.added + stat.updated,
      added: stat.added,
      updated: stat.updated,
      unchanged: stat.unchanged,
      skipped: stat.skipped,
      failed: res.failures.length,
      pins: stat.pins,
      afSlots: stat.afSlots,
      afCoverage: stat.afSlots ? Number((stat.afFilled / stat.afSlots).toFixed(4)) : 0
    },
    ...(res.enrichInfo ? {
      enrichment: {
        chips: res.enrichInfo.chips,
        megabytes: Number((res.enrichInfo.bytes / 1048576).toFixed(1)),
        chipsNotPublishedUpstream: res.enrichInfo.chipsMissing.length,
        budgetExceeded: res.enrichInfo.skippedForBudget,
        notes: res.enrichInfo.missing
      }
    } : {}),
    families: [...perFamily].map(([family, s]) => ({
      family,
      chips: s.chips,
      afCoverage: s.afSlots ? Number((s.afFilled / s.afSlots).toFixed(4)) : 0
    })).sort((a, b) => a.family.localeCompare(b.family)),
    validation: {
      checkedChips: res.validation.checkedChips,
      rules: VALIDATION_RULES,
      violations: res.validation.failures.length,
      failures: res.validation.failures
    },
    pinTypes: Object.fromEntries([...pt].sort((a, b) => b[1] - a[1])),
    functionTypes: Object.fromEntries([...ft].sort((a, b) => b[1] - a[1])),
    pinsWithAliases: ap,
    afUnmatchedTop: [...(res.afMisses ?? [])].sort().slice(0, 40)
  }
}

// Legacy top-level mirror: keep the pre-multi-vendor contract stable for existing consumers —
// `upstream`/`enrichment` describe the st pipeline when it ran (else the first vendor).
const legacy = vendorResults.has('st') ? vendorSections.st : vendorSections[selected[0]]
const datasetTotals = manifest
  ? [...Object.values(manifest.vendors)].reduce((acc, v) => ({
      chips: acc.chips + v.totals.chips,
      pins: acc.pins + v.totals.pins,
      afSlots: acc.afSlots + v.totals.afSlots,
      afFilled: acc.afFilled + v.afCount
    }), { chips: 0, pins: 0, afSlots: 0, afFilled: 0 })
  : null

const meta = {
  schemaVersion: SCHEMA_VERSION,
  checkedAt: generatedAt,
  generatedAt,
  filters: { line: opts.line, ref: opts.ref, limit: opts.limit || null, af: opts.af },
  upstream: legacy.upstream,
  run: {
    considered: totals.considered,
    written: totals.added + totals.updated,
    added: totals.added,
    updated: totals.updated,
    unchanged: totals.unchanged,
    skipped: totals.skipped,
    failed: totals.failed,
    pins: totals.pins,
    afSlots: totals.afSlots,
    afCoverage: totals.afSlots ? Number((totals.afFilled / totals.afSlots).toFixed(4)) : 0,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  },
  enrichment: legacy.enrichment ?? { chips: 0, megabytes: 0, chipsNotPublishedUpstream: 0, budgetExceeded: false, notes: [] },
  families: Object.values(vendorSections).flatMap((v) => v.families).sort((a, b) => a.family.localeCompare(b.family)),
  datasetTotals: datasetTotals
    ? {
        chips: datasetTotals.chips,
        pins: datasetTotals.pins,
        afSlots: datasetTotals.afSlots,
        afCoverage: datasetTotals.afSlots ? Number((datasetTotals.afFilled / datasetTotals.afSlots).toFixed(4)) : 0
      }
    : null,
  // 校验器：规则清单 + 实际执行数量 + 违规数（0 才代表物理 pin 层干净）
  validation: {
    checkedChips: Object.values(vendorSections).reduce((n, v) => n + v.validation.checkedChips, 0),
    rules: VALIDATION_RULES,
    violations: Object.values(vendorSections).reduce((n, v) => n + v.validation.violations, 0),
    failures: allFailures.filter(f => f.stage === 'validate').map(f => ({ chip: f.chip, error: f.error }))
  },
  pinTypes: Object.fromEntries([...pinTypes].sort((a, b) => b[1] - a[1])),
  functionTypes: Object.fromEntries([...functionTypes].sort((a, b) => b[1] - a[1])),
  pinsWithAliases: aliasedPins,
  failures: allFailures,
  warningCount: allWarnings.length,
  warningsTop: [...new Set(allWarnings)].slice(0, 40),
  afUnmatchedTop: [...afUnmatched].sort().slice(0, 40),
  vendors: vendorSections
}

if (!opts.dryRun) {
  await writeAlways(join(outDir, 'meta.json'), jsonText(meta))
} else {
  meta.datasetTotals = { dryRun: true, chips: [...vendorResults.values()].reduce((n, { res }) => n + res.docs.size, 0), pins: totals.pins }
}

const summary = {
  ok: allFailures.length === 0,
  ...meta.run,
  afCoverage: meta.run.afCoverage,
  failures: allFailures.slice(0, 10)
}

if (opts.json) console.log(JSON.stringify(summary, null, 2))
else {
  log(`\nwritten: ${totals.added} added, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.skipped} skipped, ${allFailures.length} failed`)
  log(`pins: ${totals.pins} | AF filled: ${totals.afFilled}/${totals.afSlots} (${(meta.run.afCoverage * 100).toFixed(1)}%)`)
  if (manifest) log(`dataset now: ${meta.datasetTotals.chips} chips, ${meta.datasetTotals.pins} pins, AF ${(meta.datasetTotals.afCoverage * 100).toFixed(1)}%`)
  if (afUnmatched.size) log(`AF 未匹配 token（前 10）: ${[...afUnmatched].sort().slice(0, 10).join(', ')}`)
  if (allWarnings.length) log(`warnings: ${allWarnings.length} (see meta.json)`)
  for (const f of allFailures.slice(0, 10)) log(`  FAIL ${f.chip} [${f.stage}] ${f.error}`)
  log(`done in ${meta.run.seconds}s`)
}

process.exit(allFailures.length ? 1 : 0)
