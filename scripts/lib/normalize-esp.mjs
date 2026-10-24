// ESP32 unified-doc builder: esp-idf parsed headers (pad/IOMUX/GPIO-matrix) × curated package
// overlay → the same unified chip document shape the ST pipeline emits.
//
// Schema mapping (v1.4.0, all additive):
//   * `af` is reused as the generic mux function-select value — STM32 AF number, ESP32 IOMUX
//     MCU_SEL. Fixed analog channels (ADC/touch/XTAL) carry af:null like ST's analog functions.
//   * ESP32's GPIO matrix means most peripheral signals are NOT pad-fixed: they are listed
//     chip-level in `routing` instead of being exploded onto every pin.
//   * pin.flags (new): strapping | flash | usb | jtag | input-only | output-only — curated in
//     the overlay, since esp-idf carries no machine-readable strapping/boot-role table.
//   * Package/module physical pin numbers come from the overlay (datasheet transcription);
//     QFN nomenclature includes the exposed pad as the last position (e.g. QFN32 = 33 pins).
import { SCHEMA_VERSION } from './normalize.mjs'

const GPIO_RE = /^GPIO(\d+)$/

// IO-MUX function tokens → {peripheral, signal, type}. Order matters (first match wins).
// 经典 esp32 的老命名(HSPI*/VSPI*/HS1_*/HS2_*/SD_*/EMAC_*)与 C3+ 的新命名并存。
const FUNCTION_RULES = [
  [/^FSPI(CLK|Q|D|CS\d+|HD|WP)$/, (m) => ({ peripheral: 'FSPI', signal: m[1], type: 'spi' })],
  [/^SPI(CLK|Q|D|CS\d+|HD|WP)$/, (m) => ({ peripheral: 'SPI1', signal: m[1], type: 'spi' })],
  [/^(?:HSPI|VSPI)(CLK|Q|D|HD|WP|CS0)$/, (m) => ({ peripheral: 'SPI2', signal: m[1], type: 'spi' })],
  [/^(HS1|HS2)_(.+)$/, (m) => ({ peripheral: `SDIO${m[1].slice(2)}`, signal: m[2], type: 'other' })],
  [/^SD_(.+)$/, (m) => ({ peripheral: 'SDIO', signal: m[1], type: 'other' })],
  [/^EMAC_(.+)$/, (m) => ({ peripheral: 'EMAC', signal: m[1], type: 'other' })],
  [/^U(\d)(RXD|TXD|CTS|RTS|DSR|DTR)$/, (m) => ({ peripheral: `UART${m[1]}`, signal: m[2], type: 'uart' })],
  [/^MTCK$/, () => ({ peripheral: 'JTAG', signal: 'TCK', type: 'system' })],
  [/^MTMS$/, () => ({ peripheral: 'JTAG', signal: 'TMS', type: 'system' })],
  [/^MTDI$/, () => ({ peripheral: 'JTAG', signal: 'TDI', type: 'system' })],
  [/^MTDO$/, () => ({ peripheral: 'JTAG', signal: 'TDO', type: 'system' })],
  [/^SUBSPIQ|SUBSPID|SUBSPICS\d|SUBSPIHD|SUBSPIWP$/, (m) => ({ peripheral: 'SPI3', signal: m[0].replace(/^SUBSPI/, ''), type: 'spi' })],
  [/^CLK_OUT(\d)$/, (m) => ({ peripheral: 'CLKOUT', signal: `OUT${m[1]}`, type: 'other' })]
]

const splitEspFunction = (token) => {
  for (const [re, build] of FUNCTION_RULES) {
    const m = token.match(re)
    if (m) return build(m)
  }
  return { peripheral: token, signal: token, type: 'other' }
}

// GPIO-matrix signal names (gpio_sig_map.h) reuse the same splits plus a few of their own.
const splitEspSignal = (name) => {
  let m
  if ((m = name.match(/^I2CEXT(\d)_(.+)$/))) return { peripheral: `I2C${m[1]}`, signal: m[2], type: 'i2c' }
  if ((m = name.match(/^I2S(\d)_(.+)$/))) return { peripheral: `I2S${m[1]}`, signal: m[2], type: 'spi' }
  if ((m = name.match(/^(U\d)(RXD|TXD|CTS|RTS|DSR|DTR)$/))) return { peripheral: `UART${m[1].slice(1)}`, signal: m[2], type: 'uart' }
  if ((m = name.match(/^RMT_(.+)$/))) return { peripheral: 'RMT', signal: m[1], type: 'other' }
  if ((m = name.match(/^USB_(.+)$/))) return { peripheral: 'USB', signal: m[1], type: 'usb' }
  if ((m = name.match(/^SPI(\d)_(.+)$/))) return { peripheral: `SPI${m[1]}`, signal: m[2], type: 'spi' }
  if ((m = name.match(/^PCNT_(.+)$/))) return { peripheral: 'PCNT', signal: m[1], type: 'timer' }
  return splitEspFunction(name)
}

// Non-GPIO pin names from the overlay → unified pin.type (aligned with ST's mapPinType).
const PIN_TYPE_BY_NAME = [
  [/^GND|^EPAD$/, 'ground'],
  [/^VDD|^VCC|^VBAT|^3V3$/, 'power'],
  [/^CHIP_EN|^CHIP_PU|^EN$|^RST/, 'reset'],
  [/^XTAL/, 'clock'],
  [/^LNA_IN|^RF|^ANT/, 'other'],
  [/^NC$/, 'nc']
]

const pinTypeFor = (name) => {
  for (const [re, type] of PIN_TYPE_BY_NAME) if (re.test(name)) return type
  return 'other'
}

/**
 * Build one unified chip document.
 *
 * @param {object} parsed loadTarget() result: {pads, defaults, signals, adc, touch, caps}
 * @param {object} overlay target overlay JSON (memory/flags/packages/source)
 * @param {object} pkg one overlay package entry (id/kind/package/packageKind/pinCount/parts/pinMap)
 */
export function normalizeEsp({ target, parsed, overlay, pkg, vendorName, upstreamMeta }) {
  const family = overlay.family
  const chip = `${family}-${pkg.id}`

  const flagsByGpio = new Map()
  for (const [flag, gpios] of Object.entries(overlay.flags ?? {})) {
    for (const g of gpios ?? []) {
      if (!flagsByGpio.has(g)) flagsByGpio.set(g, [])
      flagsByGpio.get(g).push(flag)
    }
  }

  const pins = []
  for (const [position, name] of Object.entries(pkg.pinMap)) {
    const gpioMatch = name.match(GPIO_RE)
    if (!gpioMatch) {
      pins.push({
        position,
        pad: name,
        primary: name,
        name,
        type: pinTypeFor(name),
        functions: []
      })
      continue
    }
    const gpio = Number(gpioMatch[1])
    const pad = parsed.pads.get(gpio)
    if (!pad) throw new Error(`overlay pin ${position} (${name}) does not exist on target ${target} (esp-idf pads table)`)

    const functions = []
    const seen = new Set()
    const push = (peripheral, signal, af, type, system = false) => {
      const key = `${peripheral}/${signal}`
      if (seen.has(key)) return
      seen.add(key)
      functions.push({ peripheral, signal, af, type, ...(system ? { system: true } : {}) })
    }

    for (const fn of pad.functions) {
      const { peripheral, signal, type } = splitEspFunction(fn.name)
      push(peripheral, signal, fn.sel, type)
    }
    for (const a of parsed.adc.get(gpio) ?? []) push(a.unit, `CH${a.channel}`, null, 'adc')
    const touch = parsed.touch.get(gpio)
    if (touch !== undefined) push('TOUCH', `CH${touch}`, null, 'adc')
    if (pad.pad.startsWith('XTAL_32K')) push('XTAL32K', pad.pad.replace('XTAL_32K_', ''), null, 'clock')

    const aliases = pad.pad.match(GPIO_RE) ? [] : [pad.pad]
    pins.push({
      position,
      pad: name,
      primary: name,
      ...(aliases.length ? { aliases } : {}),
      name: aliases.length ? `${pad.pad} (${name})` : name,
      type: 'gpio',
      ...(flagsByGpio.has(gpio) ? { flags: flagsByGpio.get(gpio) } : {}),
      functions
    })
  }

  // GPIO-matrix routing table: every peripheral signal routable to (almost) any GPIO, with the
  // IO-MUX/GPIO-default pin from io_mux_reg.h's *_GPIO_NUM macros as `defaultGpio` when present.
  const defaultBySignal = new Map()
  for (const d of parsed.defaults) defaultBySignal.set(d.signal, d.gpio)
  const routing = {
    model: 'gpio-matrix',
    signals: parsed.signals.map((s) => {
      const { peripheral, signal, type } = splitEspSignal(s.name)
      return {
        peripheral,
        signal,
        type,
        direction: s.direction,
        ...(defaultBySignal.has(s.name) ? { defaultGpio: defaultBySignal.get(s.name) } : {})
      }
    })
  }

  const gpioCount = Object.values(pkg.pinMap).filter((n) => GPIO_RE.test(n)).length

  return {
    schemaVersion: SCHEMA_VERSION,
    vendor: vendorName,
    chip,
    displayName: `${family} ${pkg.package}`,
    family,
    line: family,
    die: target,
    package: pkg.package,
    packageKind: pkg.packageKind ?? 'unknown',
    pinCount: pins.length,
    memory: {
      flashKb: overlay.memory?.flashKb ?? null,
      ramKb: overlay.memory?.ramKb ?? null,
      ioCount: gpioCount,
      voltage: null,
      temperature: null
    },
    parts: (pkg.parts ?? []).map((p) => ({
      mpn: p.mpn,
      status: p.status ?? 'Active',
      ...(p.temperature ? { temperature: p.temperature } : {})
    })),
    source: {
      primary: upstreamMeta.primary,
      overlay: upstreamMeta.overlay
    },
    routing,
    pins
  }
}
