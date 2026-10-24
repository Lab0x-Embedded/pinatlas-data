// ST source adapter — LibrePCB/stm-db (primary, per-package pinout) + embassy-rs/
// stm32-data-generated (AF numbers).
//
// Everything vendor-specific about the ST pipeline lives here; the orchestrator (sync.mjs)
// only sees unified, validated chip documents. Extracted verbatim from the pre-multi-vendor
// sync.mjs — behaviour (including log lines and failure ordering) is deliberately unchanged.
import { fetchJsonAny, listFiles, resolveRef, mapPool } from '../http.mjs'
import { normalizeStmdb, validateUnified, buildAfIndex, VALIDATION_RULES } from '../normalize.mjs'

export async function run(ctx) {
  const { vendorCfg, config, opts, transport, net, log } = ctx
  const primary = vendorCfg.primary
  const enrich = vendorCfg.enrichment

  // ── resolve upstream revisions ─────────────────────────────────────────────────────────────
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

  // Candidate URLs per file: CDN first, then raw.githubusercontent.com (config fallbackCdn) —
  // jsDelivr caps gh packages at 50 MB and the enrichment repo is far past it, so any file its
  // edge cache misses has to come from raw.
  const fileUrls = (src, ref, path) => {
    if (ref.startsWith('sha256:')) return []
    const urls = [src.cdn.replace('{ref}', ref) + path]
    if (src.fallbackCdn) urls.push(src.fallbackCdn.replace('{ref}', ref) + path)
    return urls
  }

  // ── plan the primary set ───────────────────────────────────────────────────────────────────
  const tree = await listFiles(primary.repo, primaryRev.ref, { prefix: primary.dataPrefix, opts: transport })
  if (!tree.ok) return { fatal: `FATAL: cannot list ${primary.repo}: ${tree.error}` }
  let planned = tree.files
    .map((f) => ({ ...f, chip: f.path.slice(primary.dataPrefix.length, -5) }))
    .filter((f) => /^STM32/.test(f.chip))
  if (opts.ref) planned = planned.filter((f) => f.chip === opts.ref)
  if (opts.line) planned = planned.filter((f) => f.chip.startsWith(opts.line))
  planned.sort((a, b) => a.chip.localeCompare(b.chip))
  if (opts.limit) planned = planned.slice(0, opts.limit)

  log(`  primary files: ${planned.length}${opts.line ? ` (line ${opts.line})` : ''}${opts.ref ? ` (ref ${opts.ref})` : ''}${tree.truncated ? ' [tree listing TRUNCATED]' : ''}`)
  if (!planned.length) return { fatal: 'FATAL: nothing to sync' }

  // ── download primary docs ──────────────────────────────────────────────────────────────────
  const downloads = await mapPool(planned, net.concurrency, async (f) => {
    const res = await fetchJsonAny(fileUrls(primary, primaryRev.ref, f.path), transport)
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

  // ── AF enrichment (only the chips actually needed) ─────────────────────────────────────────
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
        const res = await fetchJsonAny(fileUrls(enrich, enrichRev.ref, p.path), transport)
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

  // ── normalise + validate ───────────────────────────────────────────────────────────────────
  const warnings = []
  const afMisses = new Set()
  const kept = new Map()
  let validatedChips = 0
  for (const [chip, doc] of docs) {
    const afIndex = afIndexes.get(chip)?.index || null
    let unified
    try {
      unified = normalizeStmdb(doc, {
        ref: chip,
        vendorName: vendorCfg.vendorName,
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
      continue
    }

    const { errors, warnings: warns, checked } = validateUnified(unified)
    for (const w of warns) warnings.push(`${chip}: ${w}`)
    if (errors.length) {
      failures.push({ chip, stage: 'validate', error: errors.join('; ') })
      continue
    }
    validatedChips++
    if (checked.length !== VALIDATION_RULES.length) warnings.push(`${chip}: validator rule set mismatch`)
    kept.set(chip, unified)
  }

  const upstream = {
    primary: { repo: primary.repo, branch: primary.branch, ref: primaryRev.ref, resolved: primaryRev.resolved, commitDate: primaryRev.date },
    enrichment: opts.af
      ? { repo: enrich.repo, branch: enrich.branch, ref: enrichRev.ref, resolved: enrichRev.resolved, commitDate: enrichRev.date, requested: true }
      : { repo: enrich.repo, requested: false }
  }
  return {
    upstream,
    considered: planned.length,
    docs: kept,
    failures,
    warnings,
    afMisses,
    enrichInfo: afInfo,
    skipped: failures.filter((f) => f.stage === 'normalise' || f.stage === 'validate').length,
    validation: {
      checkedChips: validatedChips,
      failures: failures.filter(f => f.stage === 'validate').map(f => ({ chip: f.chip, error: f.error }))
    }
  }
}
