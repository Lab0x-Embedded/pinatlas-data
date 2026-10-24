// Espressif source adapter — esp-idf per-target headers + curated package overlays.
//
// Upstream model (all Apache-2.0, pinned to the latest stable release tag):
//   * components/soc/<t>/register|include/soc/io_mux_reg.h — the ESP32 analogue of an AF table:
//     `IO_MUX_GPIO<n>_REG → PERIPHS_IO_MUX_<PAD>_U` gives the GPIO↔pad-name map (MTCK, MTDI,
//     U0TXD…), `FUNC_<PAD>_<FUNC> <sel>` gives each pad's IO-MUX function-select values, and
//     `<SIG>_GPIO_NUM <n>` gives default signal→GPIO assignments (SPI/SDIO/USB…). Verified
//     byte-identical in shape across legacy esp32 and esp32c3/s3.
//   * components/soc/<t>/include/soc/gpio_sig_map.h — GPIO-matrix signal table
//     (`<SIG>_IN_IDX` / `<SIG>_OUT_IDX`): every peripheral signal routable to (almost) any pad
//     through the GPIO matrix, unlike the pad-fixed IOMUX functions above.
//   * adc_channel.h / touch_sensor_channel.h — fixed analog channel→GPIO assignments.
//   * soc_caps.h — pin-count sanity anchors.
//
// What esp-idf does NOT carry machine-readably: physical package pin numbers (datasheet PDFs
// only) and strapping/flash-flags — those live in the curated overlays under data/targets/.
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchText, resolveLatestTag, mapPool } from '../http.mjs'
import { validateUnified, VALIDATION_RULES } from '../normalize.mjs'
import { normalizeEsp } from '../normalize-esp.mjs'

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const TARGETS = [
  'esp32', 'esp32s2', 'esp32s3',
  'esp32c2', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32c61',
  'esp32h2', 'esp32p4'
]

/** Candidate repo paths per artifact, `{t}` = target. Newest layout first (esp-idf moved register
 *  headers into register/soc/ around v5; P4 nests them under hw_verN/ — verified byte-identical
 *  between hw_ver1 and hw_ver3; v6 moved touch channel tables out of components/soc into the
 *  touch HAL component; C5+ renamed the pad-alias macro shape). */
export const HEADER_FILES = {
  ioMux: [
    'components/soc/{t}/register/soc/io_mux_reg.h',
    'components/soc/{t}/include/soc/io_mux_reg.h',
    'components/soc/{t}/register/hw_ver1/soc/io_mux_reg.h',
    'components/soc/{t}/register/hw_ver3/soc/io_mux_reg.h'
  ],
  gpioSigMap: ['components/soc/{t}/include/soc/gpio_sig_map.h'],
  adc: ['components/soc/{t}/include/soc/adc_channel.h'],
  touch: [
    'components/soc/{t}/include/soc/touch_sensor_channel.h',
    'components/soc/{t}/include/soc/touch_channel.h',
    'components/esp_hal_touch_sens/{t}/include/hal/touch_sensor_channel.h'
  ],
  socCaps: ['components/soc/{t}/include/soc/soc_caps.h']
}

export const espHeaderUrl = (ref, target, file) =>
  `https://raw.githubusercontent.com/espressif/esp-idf/${ref}/${file.replaceAll('{t}', target)}`

const SELF_GPIO = /^GPIO\d+$/

/**
 * io_mux_reg.h → { pads: Map<gpio, {pad, functions: [{name, sel}]}>, defaults: [{signal, gpio}] }
 *
 * `functions` lists only the pad-fixed (IOMUX) functions with their MCU_SEL value — the ESP32
 * counterpart of an STM32 af number. The "use as plain GPIO" self-selects (FUNC_*_GPIO<n> and
 * the generator's `_0` duplicate-alias macros) are dropped; SD_x / USB_x style default pin
 * assignments are returned separately as `defaults`.
 */
export function parseIoMuxReg(text) {
  const gpioToPad = new Map()
  // Two macro generations: PERIPHS_IO_MUX_<PAD>_U (v5 era) and PERIPHS_IO_MUX_U_PAD_<PAD> (C5+, v6)
  const regRe = /#define\s+IO_MUX_GPIO(\d+)_REG\s+PERIPHS_IO_MUX_(?:U_PAD_)?([A-Z0-9_]+?)(?:_U)?\b/g
  for (const [, gpio, pad] of text.matchAll(regRe)) gpioToPad.set(Number(gpio), pad)

  const functions = new Map() // gpio → [{name, sel}]
  const funcRe = /#define\s+FUNC_([A-Z0-9_]+)\s+(\d+)\b/g
  for (const [, tokenRaw, selStr] of text.matchAll(funcRe)) {
    // `FUNC_<PAD>_GPIO<n>_0` duplicates `FUNC_<PAD>_GPIO<n>` when a pad has no named function
    // at that select value — same GPIO self-select, generator just needed a unique macro name.
    const token = tokenRaw.replace(/_GPIO(\d+)_0$/, '_GPIO$1')
    let pad = null
    for (const name of gpioToPad.values()) {
      if (token.startsWith(name + '_') && token.length > name.length + 1 &&
          (!pad || name.length > pad.length)) pad = name
    }
    if (!pad) continue
    const func = token.slice(pad.length + 1)
    if (SELF_GPIO.test(func)) continue // plain-GPIO select: represented by the pin itself
    const gpio = [...gpioToPad].find(([, p]) => p === pad)?.[0]
    if (gpio === undefined) continue
    if (!functions.has(gpio)) functions.set(gpio, [])
    functions.get(gpio).push({ name: func, sel: Number(selStr) })
  }
  for (const list of functions.values()) list.sort((a, b) => a.sel - b.sel)

  const defaults = []
  const defRe = /#define\s+((?!MAX_|MIN_)[A-Z0-9]+(?:_[A-Z0-9]+)*)_GPIO_NUM\s+(\d+)\b/g
  for (const [, signal, gpio] of text.matchAll(defRe)) defaults.push({ signal, gpio: Number(gpio) })

  const pads = new Map()
  for (const [gpio, pad] of gpioToPad) {
    pads.set(gpio, { pad, functions: functions.get(gpio) ?? [] })
  }
  return { pads, defaults }
}

/**
 * gpio_sig_map.h → [{name, direction: 'in'|'out', idx}] (GPIO-matrix signals, no pad binding —
 * any of them can be routed to any general-purpose pad). Macro-alias defines (`*_MUX_IDX`
 * pointing at another macro) are skipped by requiring a numeric value.
 */
export function parseGpioSigMap(text) {
  const out = []
  const re = /#define\s+([A-Z0-9_]+?)_(IN|OUT)_IDX\s+(\d+)\b/g
  for (const [, name, dir, idx] of text.matchAll(re)) {
    out.push({ name, direction: dir.toLowerCase(), idx: Number(idx) })
  }
  return out.sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name))
}

/** adc_channel.h → Map<gpio, [{unit: 'ADC1'|'ADC2', channel}]> (fixed analog channels). */
export function parseAdcChannels(text) {
  const out = new Map()
  const re = /#define\s+ADC(\d)_GPIO(\d+)_CHANNEL\s+(\d+)\b/g
  for (const [, unit, gpio, channel] of text.matchAll(re)) {
    const key = Number(gpio)
    if (!out.has(key)) out.set(key, [])
    out.get(key).push({ unit: `ADC${unit}`, channel: Number(channel) })
  }
  return out
}

/** touch_sensor_channel.h → Map<gpio, channelIndex> (TOUCH unit). */
export function parseTouchChannels(text) {
  const out = new Map()
  const re = /#define\s+TOUCH_PAD_GPIO(\d+)_CHANNEL\s+(\d+)\b/g
  for (const [, gpio, channel] of text.matchAll(re)) out.set(Number(gpio), Number(channel))
  return out
}

/** soc_caps.h → {gpioPinCount} (best effort; used only as a cross-check anchor). */
export function parseSocCaps(text) {
  const m = text.match(/#define\s+SOC_GPIO_PIN_COUNT\s+(\d+)\b/)
  return { gpioPinCount: m ? Number(m[1]) : null }
}

/**
 * Fetch one artifact for a target, trying the candidate paths in order. 404 on every candidate
 * returns null — optional artifacts (touch on C3, adc on some targets) are legitimately absent.
 */
export async function fetchHeader(ref, target, candidates, transport) {
  for (const file of candidates) {
    const res = await fetchText(espHeaderUrl(ref, target, file), { ...transport, tries: 2 })
    if (res.ok) return { text: res.data, file }
  }
  return null
}

/**
 * Fetch + parse the full header set for one target.
 * Returns {target, files: {ioMux, gpioSigMap, adc?, touch?, socCaps?}, parsed: {...}} or
 * {target, error} when a mandatory artifact (ioMux / gpioSigMap) is missing.
 */
export async function loadTarget(ref, target, transport) {
  const files = {}
  const ioMux = await fetchHeader(ref, target, HEADER_FILES.ioMux, transport)
  if (!ioMux) return { target, error: 'io_mux_reg.h not found at any known path' }
  files.ioMux = ioMux.file
  const sigMap = await fetchHeader(ref, target, HEADER_FILES.gpioSigMap, transport)
  if (!sigMap) return { target, error: 'gpio_sig_map.h not found at any known path' }
  files.gpioSigMap = sigMap.file

  const [adc, touch, socCaps] = await Promise.all([
    fetchHeader(ref, target, HEADER_FILES.adc, transport),
    fetchHeader(ref, target, HEADER_FILES.touch, transport),
    fetchHeader(ref, target, HEADER_FILES.socCaps, transport)
  ])
  if (adc) files.adc = adc.file
  if (touch) files.touch = touch.file
  if (socCaps) files.socCaps = socCaps.file

  const ioMuxParsed = parseIoMuxReg(ioMux.text)
  return {
    target,
    files,
    parsed: {
      pads: ioMuxParsed.pads,
      defaults: ioMuxParsed.defaults,
      signals: parseGpioSigMap(sigMap.text),
      adc: adc ? parseAdcChannels(adc.text) : new Map(),
      touch: touch ? parseTouchChannels(touch.text) : new Map(),
      caps: socCaps ? parseSocCaps(socCaps.text) : { gpioPinCount: null }
    }
  }
}

// ── source adapter (contract: see sync.mjs) ─────────────────────────────────────────────────────

/** Read the curated overlay JSONs. Every overlay file present = one target we ship.
 *  A malformed overlay is a single-target failure, not a pipeline crash. */
async function loadOverlays(vendorCfg, onFailure) {
  const dir = pathResolve(ROOT, vendorCfg.overlay)
  const out = new Map()
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    try {
      out.set(f.replace(/\.json$/, ''), JSON.parse(await readFile(join(dir, f), 'utf8')))
    } catch (err) {
      onFailure?.({ file: f, error: err?.message || String(err) })
    }
  }
  return out
}

export async function run(ctx) {
  const { vendorCfg, opts, transport, net, log } = ctx
  const primary = vendorCfg.primary

  const rev = await resolveLatestTag(primary.repo, transport)
  if (!rev.resolved) return { fatal: `FATAL: cannot resolve latest release of ${primary.repo} (${rev.error})` }
  log(`  esp-idf    ${primary.repo}@${rev.ref}`)

  const overlayFailures = []
  const overlays = await loadOverlays(vendorCfg, (f) => overlayFailures.push(f))
  const unknown = [...overlays.keys()].filter((t) => !TARGETS.includes(t))
  const missing = TARGETS.filter((t) => !overlays.has(t))
  log(`  overlay:   ${overlays.size}/${TARGETS.length} targets` +
      (missing.length ? ` (no overlay yet: ${missing.join(', ')})` : '') +
      (unknown.length ? ` [UNKNOWN in TARGETS: ${unknown.join(', ')}]` : '') +
      (overlayFailures.length ? ` [PARSE FAILED: ${overlayFailures.map((f) => f.file).join(', ')}]` : ''))

  // plan: one chip per (target × overlay package), filtered like the ST pipeline filters refs
  let planned = []
  for (const [target, overlay] of overlays) {
    for (const pkg of overlay.packages) planned.push({ target, overlay, pkg, chip: `${overlay.family}-${pkg.id}` })
  }
  if (opts.ref) planned = planned.filter((p) => p.chip === opts.ref)
  if (opts.line) planned = planned.filter((p) => p.overlay.family.toLowerCase().startsWith(String(opts.line).toLowerCase()))
  planned.sort((a, b) => a.chip.localeCompare(b.chip))
  if (opts.limit) planned = planned.slice(0, opts.limit)
  if (!planned.length) return { fatal: 'FATAL: nothing to sync' }
  log(`  chips:     ${planned.length}${opts.ref ? ` (ref ${opts.ref})` : ''}${opts.line ? ` (line ${opts.line})` : ''}`)

  // esp-idf headers are shared per target — fetch each once (few small files, low concurrency)
  const targets = [...new Set(planned.map((p) => p.target))]
  const loaded = await mapPool(targets, Math.min(4, net.concurrency), async (t) => loadTarget(rev.ref, t, transport))
  const byTarget = new Map()
  const failures = overlayFailures.map((f) => ({
    chip: f.file.replace(/\.json$/, ''), stage: 'overlay', error: f.error
  }))
  for (const r of loaded) {
    // loadTarget reports missing mandatory headers as a plain {target, error} value (it cannot
    // throw from inside mapPool's error slot), so check both layers before trusting r.value.
    if (r.ok && !r.value.error) byTarget.set(r.value.target, r.value)
    else failures.push({ chip: r.item, stage: 'download-primary', error: r.ok ? r.value.error : r.error })
  }

  const warnings = []
  const docs = new Map()
  let validatedChips = 0
  for (const { target, overlay, pkg, chip } of planned) {
    const td = byTarget.get(target)
    if (!td) continue // already recorded as a download failure above
    if (td.parsed.caps.gpioPinCount && td.parsed.pads.size > td.parsed.caps.gpioPinCount) {
      warnings.push(`${chip}: esp-idf pads (${td.parsed.pads.size}) exceed SOC_GPIO_PIN_COUNT (${td.parsed.caps.gpioPinCount}) — parser drift?`)
    }
    let unified
    try {
      unified = normalizeEsp({
        target,
        parsed: td.parsed,
        overlay,
        pkg,
        vendorName: vendorCfg.vendorName,
        upstreamMeta: {
          primary: { repo: primary.repo, ref: rev.ref, path: Object.values(td.files), license: primary.license },
          overlay: { path: `${vendorCfg.overlay}/${target}.json`, source: overlay.source ?? null }
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
    docs.set(chip, unified)
  }

  return {
    upstream: {
      primary: { repo: primary.repo, branch: null, ref: rev.ref, resolved: rev.resolved, commitDate: rev.date, kind: 'release-tag' },
      enrichment: { repo: null, requested: false }
    },
    considered: planned.length,
    docs,
    failures,
    warnings,
    afMisses: new Set(),
    enrichInfo: null,
    skipped: failures.filter((f) => f.stage === 'normalise' || f.stage === 'validate').length,
    validation: {
      checkedChips: validatedChips,
      failures: failures.filter((f) => f.stage === 'validate').map((f) => ({ chip: f.chip, error: f.error }))
    }
  }
}
