// Normalisation: LibrePCB/stm-db JSON → PinAtlas unified JSON, plus the AF join against
// embassy-rs/stm32-data-generated.
//
// Three upstream quirks drive most of this file (all measured over 2952 stm-db files):
//   1. `pinout` is NOT one entry per physical pin. 14% of linear-package files repeat a
//      `position` for pin-remap variants (e.g. STM32G031K8Tx / LQFP32 ships 36 entries, with
//      `PA11 [PA9]` + variant PINREMAP). Render the array as-is and you draw 36 pins on a
//      32-pin package. Entries are therefore merged by position; alternates live in `variants`.
//   2. `position` is a linear pin number for QFP/QFN/TSSOP, but a grid coordinate (A1, B7) for
//      BGA/WLCSP — 55% of pins in a 486-file sample are grid. `packageKind` records which.
//   3. `signals` are flat strings ("TIM2_CH1", "GPIO", "SYS_WKUP", "ADC1_EXTI11"). Splitting
//      yields the peripheral/signal pair; a few tokens have no underscore at all.
//
// AF numbers do not exist in stm-db. embassy publishes them the other way round
// (peripheral → pin → af), so this module inverts that into `pin|TOKEN → af`; measured hit rate
// on matched tokens is 93.6% overall, 0% for STM32F1 (embassy has no AF data there).

const SYSTEM_PREFIXES = new Set(['RCC', 'SYS'])

/** Peripheral-name aliases between the two upstreams (evidence-driven, extend as needed). */
const PERIPHERAL_ALIASES = {
  FSMC: ['FMC'],
  FMC: ['FSMC'],
  SDIO: ['SDMMC'],
  SDMMC: ['SDIO'],
  ETH: ['ETH1'],
  ETH1: ['ETH']
}

export function packageKind(pkg, positions = []) {
  const p = String(pkg || '').toUpperCase()
  const linear = positions.length > 0 && positions.every(v => /^\d+$/.test(String(v)))
  const named = /(BGA|WLCSP|CSP|LGA)/.test(p)
    ? 'grid'
    : /(QFPN|QFN|LQFP|TQFP|PQFP|QFP|DFN|FQFN)/.test(p)
        ? 'quad'
        : /(TSSOP|SSOP|SOP|SOIC|DIP|SO\d)/.test(p)
            ? 'dual'
            : 'unknown'

  // 名字像网格但数据是线性编号（如 LGA77 模块）→ 画不出真实网格，按线性近似并保留告警
  if (named === 'grid' && linear) return 'unknown'
  // 名字不认识但数据是行列坐标 → 按网格处理
  if (named === 'unknown' && !linear) return 'grid'
  return named
}

/** Trailing digits of most package names are the pin/ball count ("LQFP48", "TFBGA361"). */
export function packagePinCount(pkg) {
  const m = /(\d+)\s*$/.exec(String(pkg || ''))
  return m ? Number(m[1]) : null
}

/** Raw stm-db pin type → semantic type. `ground`/`clock`/`analog` do not exist upstream:
 *  ground comes from the pin name (VSS*), clock/analog are left to the frontend via the
 *  function list and the `osc` flag — never inferred from a pin name alone. */
export function mapPinType(rawType, name) {
  const raw = String(rawType || '').trim()
  const n = String(name || '').toUpperCase()
  switch (raw) {
    case 'I/O': return 'io'
    case 'Power': return n.startsWith('VSS') ? 'ground' : 'power'
    case 'Reset': return 'reset'
    case 'Boot': return 'boot'
    case 'MonoIO': return 'mono'
    case 'NC': return 'nc'
    default: return 'other'
  }
}

/** "TIM2_CH1" → {peripheral:'TIM2', signal:'CH1'}; "GPIO" → {kind:'gpio'}; "SYS_WKUP" → system. */
export function splitToken(token) {
  const t = String(token || '')
  if (t === 'GPIO') return { kind: 'gpio', peripheral: 'GPIO', signal: '' }
  const i = t.indexOf('_')
  if (i < 0) return { kind: 'peripheral', peripheral: t, signal: '' }
  const peripheral = t.slice(0, i)
  const signal = t.slice(i + 1)
  const kind = SYSTEM_PREFIXES.has(peripheral) ? 'system' : 'peripheral'
  return { kind, peripheral, signal }
}

/** pad name of a pin entry, remap annotations stripped: "PA11 [PA9]" → "PA11" */
export const pinPad = (name) => {
  const m = /^([A-Za-z]+\d+)/.exec(String(name || '').trim())
  return m ? m[1].toUpperCase() : String(name || '').trim().toUpperCase()
}

/** Candidate stm-db tokens for one embassy pin entry (embassy and stm-db name the same
 *  function differently in places — most visibly I2S, which embassy files under SPI<n>). */
export function tokenCandidates(peripheral, signal) {
  const out = new Set([`${peripheral}_${signal}`, signal])
  const i2s = /^I2S_(CK|SCK|WS|SD|MCK)$/.exec(signal)
  const spi = /^SPI(\d)$/.exec(peripheral)
  if (i2s && spi) {
    const n = spi[1]
    out.add(`I2S${n}_${i2s[1]}`)
    if (i2s[1] === 'CK') out.add(`I2S${n}_SCK`)
    if (i2s[1] === 'SCK') out.add(`I2S${n}_CK`)
  }
  for (const alt of PERIPHERAL_ALIASES[peripheral] || []) out.add(`${alt}_${signal}`)
  return [...out]
}

/** embassy chip doc → Map<`PAD|TOKEN`, af>. Also reports the peripheral-signal pairs present,
 *  so unmatched pairs can be tallied for future alias work. */
export function buildAfIndex(embassyDoc) {
  const index = new Map()
  const pairs = new Set()
  for (const core of embassyDoc?.cores || []) {
    for (const per of core.peripherals || []) {
      if (/^(GPIO|.*_COMMON)/.test(per.name)) continue // GPIO pins are empty upstream anyway
      for (const p of per.pins || []) {
        if (typeof p.af !== 'number') continue
        const pad = pinPad(p.pin)
        pairs.add(`${per.name}_${p.signal}`)
        for (const cand of tokenCandidates(per.name, p.signal)) index.set(`${pad}|${cand}`, p.af)
      }
    }
  }
  return { index, pairs: [...pairs] }
}

/** Tokens that never carry an AF number (analog channels, EXTI lines, plain GPIO) — excluded from
 *  the unmatched-AF tally so the list in meta.json stays actionable. */
const AF_NEVER = /^(ADC\d+_(IN|INN|EXTI)|DAC\d+_OUT|GPIO)/

const compactSignal = (token, afIndex, pad, afMisses) => {
  const { kind, peripheral, signal } = splitToken(token)
  if (kind === 'gpio') return null
  const af = afIndex?.get(`${pad}|${token}`)
  if (afIndex && af === undefined && kind === 'peripheral' && !AF_NEVER.test(token)) {
    afMisses?.add(`${peripheral}_${signal}`)
  }
  return { peripheral, signal, af: af ?? null, ...(kind === 'system' ? { system: true } : {}) }
}

/** stm-db doc → unified doc. `afIndex` is optional (AF enrichment off). */
export function normalizeStmdb(doc, { ref, vendorName, afIndex = null, sourceMeta = {}, afMisses = null } = {}) {
  const names = doc.names || {}
  const info = doc.info || {}
  const byPosition = new Map()
  for (const p of doc.pinout || []) {
    const key = String(p.position)
    if (!byPosition.has(key)) byPosition.set(key, [])
    byPosition.get(key).push(p)
  }

  const pins = []
  for (const [position, entries] of byPosition) {
    const base = entries.find((e) => !e.variant) || entries[0]
    const pad = pinPad(base.name)
    const functions = (base.signals || []).map((t) => compactSignal(t, afIndex, pad, afMisses)).filter(Boolean)
    const variants = {}
    for (const e of entries) {
      if (!e.variant) continue
      variants[e.variant] = {
        name: e.name,
        type: mapPinType(e.type, e.name),
        functions: (e.signals || []).map((t) => compactSignal(t, afIndex, pinPad(e.name), afMisses)).filter(Boolean)
      }
    }
    const isOsc = /-OSC/.test(String(base.name)) || (base.signals || []).some((t) => /^RCC_OSC/.test(t))
    pins.push({
      position,
      pad,
      name: base.name,
      type: mapPinType(base.type, base.name),
      rawType: base.type,
      ...(isOsc ? { osc: true } : {}),
      functions,
      ...(Object.keys(variants).length ? { variants } : {})
    })
  }

  const pkg = doc.package || null
  return {
    schemaVersion: '1.0.0',
    vendor: vendorName,
    chip: ref,
    displayName: names.name || ref,
    family: names.family || null,
    line: names.line || null,
    die: doc.silicon?.die || null,
    package: pkg,
    packageKind: packageKind(pkg, (doc.pinout || []).map(p => p.position)),
    pinCount: pins.length,
    memory: {
      flashKb: info.flash ?? null,
      ramKb: info.ram ?? null,
      ioCount: info.io ?? null,
      voltage: info.voltage ?? null,
      temperature: info.temperature ?? null
    },
    parts: (doc.parts || []).map((p) => ({
      mpn: p.mpn,
      status: p.status ?? null,
      temperature: p.temperature_min != null ? [p.temperature_min, p.temperature_max] : null
    })),
    source: sourceMeta,
    pins
  }
}

/** Hard errors mean "do not publish this file"; warnings are recorded for the report. */
export function validateUnified(u) {
  const errors = []
  const warnings = []
  if (!u.chip) errors.push('missing chip id')
  if (!u.package) errors.push('missing package')
  if (!u.pins?.length) errors.push('no pins')
  if (!u.die) warnings.push('missing die')

  const seen = new Set()
  for (const p of u.pins) {
    if (seen.has(p.position)) errors.push(`duplicate position ${p.position} after variant merge`)
    seen.add(p.position)
    if (!p.name) errors.push(`pin ${p.position} has empty name`)
    if (p.rawType && !['I/O', 'Power', 'Reset', 'Boot', 'MonoIO', 'NC'].includes(p.rawType)) {
      warnings.push(`unknown raw pin type ${p.rawType} @${p.position}`)
    }
  }

  const expected = packagePinCount(u.package)
  if (expected != null && u.packageKind !== 'grid' && expected !== u.pins.length) {
    warnings.push(`package ${u.package} implies ${expected} pins, file has ${u.pins.length}`)
  }
  if (u.packageKind === 'unknown') warnings.push(`package kind unresolved for ${u.package}（按线性近似排列，需对照数据手册）`)

  if (u.packageKind === 'quad' && u.pins.length % 4 !== 0) {
    warnings.push(`quad package with ${u.pins.length} pins is not divisible by 4`)
  }
  if (u.packageKind === 'dual' && u.pins.length % 2 !== 0) {
    warnings.push(`dual package with ${u.pins.length} pins is not even`)
  }
  if (u.packageKind === 'grid') {
    // 大封装（实测 TFBGA361 / STM32MP）的 position 混用三种编码：A1、AA1、1J3。
    // 只要求能识别成"行 + 列"，形态混合只记 warning（排列是否正确需对照数据手册）。
    const forms = new Set()
    const bad = u.pins.filter((p) => {
      const m = /^(\d{0,2})([A-Z]{1,3})(\d{1,2})$/.exec(String(p.position))
      if (!m) return true
      forms.add(m[1] ? 'digit-prefixed' : m[2].length > 1 ? 'two-letter' : 'letter')
      return false
    })
    const linearCount = u.pins.filter((p) => /^\d+$/.test(String(p.position))).length
    if (linearCount) warnings.push(`${linearCount} grid pins use linear numbering（无行列坐标，无法还原真实网格）`)
    if (bad.length) errors.push(`${bad.length} grid pins without a row+column coordinate (${bad.slice(0, 3).map((p) => p.position).join(', ')})`)
    else if (forms.size > 1) warnings.push(`grid position 编码混合：${[...forms].join(' + ')}（排列需对照数据手册）`)
  } else {
    const nums = u.pins.map((p) => Number(p.position)).sort((a, b) => a - b)
    if (nums.some((n) => !Number.isInteger(n))) errors.push('non-numeric position in a non-grid package')
    else if (nums.some((n, i) => n !== i + 1)) warnings.push('linear pin numbering is not contiguous 1..N')
  }
  return { errors, warnings }
}
