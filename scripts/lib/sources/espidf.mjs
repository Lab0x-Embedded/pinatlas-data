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
import { fetchText } from '../http.mjs'

export const TARGETS = [
  'esp32', 'esp32s2', 'esp32s3',
  'esp32c2', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32c61',
  'esp32h2', 'esp32p4'
]

/** Candidate paths per artifact, newest layout first (esp-idf moved register headers into
 *  register/soc/ around v5; touch has two historical filenames). */
export const HEADER_FILES = {
  ioMux: ['register/soc/io_mux_reg.h', 'include/soc/io_mux_reg.h'],
  gpioSigMap: ['include/soc/gpio_sig_map.h'],
  adc: ['include/soc/adc_channel.h'],
  touch: ['include/soc/touch_sensor_channel.h', 'include/soc/touch_channel.h'],
  socCaps: ['include/soc/soc_caps.h']
}

export const espHeaderUrl = (ref, target, file) =>
  `https://raw.githubusercontent.com/espressif/esp-idf/${ref}/components/soc/${target}/${file}`

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
  const regRe = /#define\s+IO_MUX_GPIO(\d+)_REG\s+PERIPHS_IO_MUX_([A-Z0-9_]+)_U\b/g
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
