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

/** 统一 schema 版本（normalize.mjs 写进芯片文档、sync.mjs 写进 meta.json，必须同源） */
export const SCHEMA_VERSION = '1.2.0'

/**
 * 上游把「模拟能力 + EXTI 线」合成了一个 token。实测全库 63979 个，只有 5 种形态：
 *   ADC#_EXTI#（48292）、DAC#_EXTI#（10198）、DAC_EXTI#（3715）、ADC_EXTI#（1435）、SDADC#_EXTI#（339）
 *
 * 证据（为什么必须纠偏，而不是"按原样拆、前端显示原 token"）：
 *   1. token 里的数字是 **EXTI 线号 = 脚位序号**（63977/63979 成立；唯二例外是 STM32U5 的 PC5 →
 *      DAC1_EXTI9），而 ST 官方 pin data（`STM32_open_pin_data` 的 `mcu/STM32F407V(E-G)Tx.xml`）
 *      里 PB9 原文就是 `<Signal Name="DAC_EXTI9"/>`，真 DAC 输出写作 `DAC_OUT1/OUT2`（PA4/PA5）。
 *      → 前缀不是"这个脚属于该外设"，按第一个下划线拆会得到 `DAC` + `EXTI9` 的假分组。
 *   2. 前缀外设在这个脚上往往根本不存在：F407 的 PA11 不是 ADC 输入（ADC1_IN11 是 PC1），
 *      却挂着 ADC1_EXTI11/ADC2_EXTI11/ADC3_EXTI11。真模拟通道另有 `ADCn_INm` token（PC4 =
 *      ADC1_IN14），所以丢掉前缀不丢信息。
 *   3. EXTI 永远拿不到 AF 号：embassy 生成的 9 个家族（F1/F0/F4/F7/G0/G4/H7/L4/U5/WB/C0）里
 *      `EXTI` 外设的 pins 全是空数组 → 归成 system（不计入 AF 覆盖统计、不污染 afUnmatchedTop）。
 */
const EXTI_TOKEN = /^(?:[A-Z]*ADC\d*|SDADC\d*|DAC\d*)_EXTI(\d+)$/

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
    case 'I/O': return 'gpio'
    case 'Power': return n.startsWith('VSS') ? 'ground' : 'power'
    case 'Reset': return 'reset'
    case 'Boot': return 'boot'
    case 'MonoIO': return 'mono'
    case 'NC': return 'nc'
    default: return 'other'
  }
}

/** "TIM2_CH1" → {peripheral:'TIM2', signal:'CH1'}; "GPIO" → {kind:'gpio'}; "SYS_WKUP" → system;
 *  "DAC_EXTI9"/"ADC1_EXTI11" → {kind:'exti', peripheral:'EXTI', signal:'EXTI9'}（见 EXTI_TOKEN 注释）。 */
export function splitToken(token) {
  const t = String(token || '')
  if (t === 'GPIO') return { kind: 'gpio', peripheral: 'GPIO', signal: '' }
  const exti = EXTI_TOKEN.exec(t)
  if (exti) return { kind: 'exti', peripheral: 'EXTI', signal: `EXTI${exti[1]}` }
  const i = t.indexOf('_')
  if (i < 0) return { kind: 'peripheral', peripheral: t, signal: '' }
  const peripheral = t.slice(0, i)
  const signal = t.slice(i + 1)
  const kind = SYSTEM_PREFIXES.has(peripheral) ? 'system' : 'peripheral'
  return { kind, peripheral, signal }
}

/**
 * 把上游混在名字里的四类信息拆开（见 docs/08 §2.1）：
 *   "PC13-TAMPER-RTC"      → primary=PC13, aliases=[TAMPER, RTC]
 *   "VDD/VDDA"             → primary=VDD,  aliases=[VDDA]
 *   "VSSA/VREF-"           → primary=VSSA, aliases=[VREF-]（负参考的连字符要保留）
 *   "PC14-OSC32_IN (PC14)" → primary=PC14, aliases=[OSC32_IN]（括号里与主名相同则丢弃）
 *   "PA13 (JTMS/SWDIO)"    → primary=PA13, aliases=[JTMS, SWDIO]
 *   "PA11 [PA9]"           → primary=PA11, variantOf=PA9（变体重映射，不是别名）
 *   "PC2_C"                → primary=PC2（_C 是模拟开关后缀，主名要取焊盘 token）
 *
 * 顺序很重要：**先摘掉括号注释与方括号标注，再按 / 和 - 拆**。
 * 否则 "PA13 (JTMS/SWDIO)" 会被斜杠拆成 primary="PA13 (JTMS"，AF join 键失配
 * （实测 STM32L412C8Ux 因此少 17 个 AF，整个 L4/L5/H7/U5 家族覆盖率都掉）。
 */
export function splitPinName(name) {
  let raw = String(name || '').trim()

  // 1) 方括号：重映射标注（指向另一个 pad）
  const bracket = raw.lastIndexOf('[')
  const hasBracket = bracket >= 0 && raw.endsWith(']')
  const variantOf = hasBracket ? raw.slice(bracket + 1, raw.length - 1).trim().toUpperCase() || null : null
  if (hasBracket) raw = raw.slice(0, bracket).trim()

  // 2) 圆括号：行尾注释（JTMS/SWDIO、OSC32_IN 这类），内容当别名
  const paren = raw.lastIndexOf('(')
  const hasParen = paren >= 0 && raw.endsWith(')')
  const parenAliases = hasParen
    ? raw.slice(paren + 1, raw.length - 1).split(/[/-]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    : []
  if (hasParen) raw = raw.slice(0, paren).trim()

  const aliases = []
  // 3) 主名优先取"字母 + 数字"的焊盘 token：这是 embassy AF join 的键
  //    PC2_C → PC2（_C 是模拟开关后缀）；PC13_TAMPER → PC13；PC13-TAMPER-RTC → PC13
  const token = /^([A-Za-z]+\d+)/.exec(raw)
  let primary
  if (token) {
    primary = token[1].toUpperCase()
    // 下划线属于信号名（OSC_IN），只能按 / 和 - 拆；再剥掉首尾的 _ 与空白
    const leftover = raw.slice(token[1].length).split(/[/-]/)
    for (const part of leftover.map((s) => s.trim().replace(/^[\s_]+|[\s_]+$/g, '').toUpperCase())) {
      if (part.length > 1) aliases.push(part)
    }
  }
  else {
    // 4) 没有焊盘 token（VDD/VDDA、VSSA/VREF-、PDR_ON 这类）：按 / 再按 - 拆，第一段为主名
    const segments = raw.split('/').map((s) => s.trim()).filter(Boolean)
    const dashParts = (segments[0] || raw).split('-').map((s) => s.trim())
    primary = (dashParts[0] || raw).toUpperCase()
    for (const part of dashParts.slice(1)) if (part) aliases.push(part.toUpperCase())
    for (const part of segments.slice(1)) if (part) aliases.push(part.toUpperCase())
  }

  for (const part of parenAliases) if (part) aliases.push(part)

  // 括号注释等于主名时丢弃（"PH0-OSC_IN (PH0)" 这种冗余），别名也不该等于主名
  return { primary, aliases: [...new Set(aliases)].filter((a) => a && a !== primary), variantOf }
}

/** pad 名 = 主名（去掉别名与变体标注）："VSSA/VREF-" → "VSSA" */
export const pinPad = (name) => splitPinName(name).primary

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
 *  the unmatched-AF tally so the list in meta.json stays actionable. EXTI 现在由 splitToken 归成
 *  kind='exti'，压根走不到这里（那段分支留作历史形态说明）。*/
const AF_NEVER = /^(ADC\d+_(IN|INN|EXTI)|DAC\d+_OUT|GPIO)/

/** 外设前缀 → 功能大类（分组用；原始 peripheral 名保留，信息不丢） */
const FUNCTION_TYPE_RULES = [
  [/^ADC/, 'adc'],
  [/^(TIM|LPTIM|HRTIM)/, 'timer'],
  [/^(SPI|I2S|SAI)/, 'spi'],
  [/^(I2C|I3C)/, 'i2c'],
  [/^(USART|UART|LPUART)/, 'uart'],
  [/^(CAN|FDCAN)/, 'can'],
  [/^(USB|OTG)/, 'usb'],
]

export function functionType(peripheral, kind) {
  if (kind === 'system') return 'system'
  if (kind === 'exti') return 'exti'
  for (const [pattern, type] of FUNCTION_TYPE_RULES) {
    if (pattern.test(String(peripheral || ''))) return type
  }
  return 'other'
}

const compactSignal = (token, afIndex, pad, afMisses) => {
  const { kind, peripheral, signal } = splitToken(token)
  if (kind === 'gpio') return null
  const af = afIndex?.get(`${pad}|${token}`)
  if (afIndex && af === undefined && kind === 'peripheral' && !AF_NEVER.test(token)) {
    afMisses?.add(`${peripheral}_${signal}`)
  }
  return {
    peripheral,
    signal,
    af: af ?? null,
    type: functionType(peripheral, kind),
    // EXTI 线不是可配置外设、也永远没有 AF 号（embassy 的 EXTI 外设 pins 恒为空）
    // → 与 RCC_/SYS_ 同样标 system，前端按 type 单独成「外部中断」块
    ...(kind === 'system' || kind === 'exti' ? { system: true } : {})
  }
}

/**
 * 拆 + 去重。去重的必要性是实测的：18781 个引脚同时挂 2~3 个同线号 token
 * （ADC1_EXTI11 + ADC2_EXTI11 + ADC3_EXTI11 在 F4 的每个 *11 脚上），
 * 归成 EXTI11 后会变成 3 条完全相同的功能项。
 */
const compactSignals = (signals, afIndex, pad, afMisses) => {
  const seen = new Set()
  const out = []
  for (const token of signals || []) {
    const fn = compactSignal(token, afIndex, pad, afMisses)
    if (!fn) continue
    const key = `${fn.peripheral}|${fn.signal}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fn)
  }
  return out
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
    const functions = compactSignals(base.signals, afIndex, pad, afMisses)
    const variants = {}
    for (const e of entries) {
      if (!e.variant) continue
      const v = splitPinName(e.name)
      variants[e.variant] = {
        name: e.name,
        primary: v.primary,
        ...(v.aliases.length ? { aliases: v.aliases } : {}),
        type: mapPinType(e.type, e.name),
        functions: compactSignals(e.signals, afIndex, pinPad(e.name), afMisses)
      }
    }
    const isOsc = /-OSC/.test(String(base.name)) || (base.signals || []).some((t) => /^RCC_OSC/.test(t))
    const { primary, aliases, variantOf } = splitPinName(base.name)
    const mappedType = mapPinType(base.type, base.name)
    // OSC 脚单独成类（时钟）：rawType 只有 I/O，但物理上就是时钟脚
    const type = isOsc && mappedType === 'gpio' ? 'clock' : mappedType
    pins.push({
      position,
      pad,
      primary,
      ...(aliases.length ? { aliases } : {}),
      ...(variantOf ? { variantOf } : {}),
      name: base.name,
      type,
      rawType: base.type,
      ...(isOsc ? { osc: true } : {}),
      functions,
      ...(Object.keys(variants).length ? { variants } : {})
    })
  }

  const pkg = doc.package || null
  return {
    schemaVersion: SCHEMA_VERSION,
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

/**
 * 校验清单（docs/08 §2.5）。物理 pin 相关的都是硬错误（不发布该文件），
 * functions / aliases 允许重复（VSS 多脚同名、一个功能出现在多个脚上都正常）。
 */
export const VALIDATION_RULES = [
  'position-present',
  'position-unique',
  'primary-present',
  'primary-clean',
  'name-present',
  'pin-count-matches-package',
  'position-format',
  'package-kind-resolved',
]

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
    if (!p.position) errors.push('pin without position')
    if (seen.has(p.position)) errors.push(`duplicate position ${p.position} after variant merge`)
    seen.add(p.position)
    if (!p.name) errors.push(`pin ${p.position} has empty name`)
    if (!p.primary) errors.push(`pin ${p.position} has empty primary (name: ${p.name})`)
    // primary 里残留空格/括号说明注释没摘干净（曾导致 AF join 键失配：STM32L412C8Ux 少 17 个 AF）
    else if (/[\s([\]]/.test(p.primary)) errors.push(`pin ${p.position} primary has annotation leftovers: ${p.primary}`)
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
  return { errors, warnings, checked: VALIDATION_RULES }
}
