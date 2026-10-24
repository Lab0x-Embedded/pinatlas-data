// normalize-esp — 用最小化的 parsed/overlay 夹具验证 IOMUX→functions 映射、固定模拟通道、
// flags 传播与 overlay↔pads 交叉校验(脚号数据正确性由真实 e2e 运行兜底)。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeEsp } from '../normalize-esp.mjs'

const parsed = {
  pads: new Map([
    [2, { pad: 'GPIO2', functions: [{ name: 'FSPIQ', sel: 2 }] }],
    [6, { pad: 'MTCK', functions: [{ name: 'MTCK', sel: 0 }, { name: 'FSPICLK', sel: 2 }] }],
    [12, { pad: 'SPIHD', functions: [{ name: 'SPIHD', sel: 0 }] }],
    [20, { pad: 'U0RXD', functions: [{ name: 'U0RXD', sel: 0 }] }],
    [21, { pad: 'U0TXD', functions: [{ name: 'U0TXD', sel: 0 }] }]
  ]),
  defaults: [{ signal: 'SPI_HD', gpio: 12 }],
  signals: [
    { name: 'I2CEXT0_SCL', direction: 'in', idx: 60 },
    { name: 'U0RXD', direction: 'in', idx: 44 },
    { name: 'SPIQ', direction: 'out', idx: 1 }
  ],
  adc: new Map([[2, [{ unit: 'ADC1', channel: 2 }]]]),
  touch: new Map([[20, 1]]),
  caps: { gpioPinCount: 22 }
}

const overlay = {
  target: 'esp32c3',
  family: 'ESP32-C3',
  memory: { ramKb: 400 },
  flags: { strapping: [2], flash: [12], jtag: [6] },
  packages: [{
    id: 'TEST8',
    kind: 'chip',
    package: 'TEST8',
    packageKind: 'quad',
    pinCount: 8,
    parts: [{ mpn: 'ESP32-C3TEST', status: 'Active', temperature: [-40, 105] }],
    pinMap: { '1': 'GPIO2', '2': 'GPIO6', '3': 'GPIO12', '4': 'GPIO20', '5': 'GPIO21', '6': 'VDD3P3', '7': 'XTAL_N', '8': 'GND' }
  }],
  source: 'fixture'
}

const doc = normalizeEsp({
  target: 'esp32c3', parsed, overlay, pkg: overlay.packages[0],
  vendorName: 'Espressif Systems',
  upstreamMeta: { primary: { repo: 'espressif/esp-idf', ref: 'vX', path: ['a.h'], license: 'Apache-2.0' }, overlay: { path: 'x.json', source: 'fixture' } }
})

const byPrimary = Object.fromEntries(doc.pins.map((p) => [p.primary, p]))

test('IOMUX 功能 → {peripheral, signal, af=MCU_SEL}', () => {
  assert.deepEqual(byPrimary.GPIO6.functions, [
    { peripheral: 'JTAG', signal: 'TCK', af: 0, type: 'system' },
    { peripheral: 'FSPI', signal: 'CLK', af: 2, type: 'spi' }
  ])
  assert.deepEqual(byPrimary.GPIO2.functions, [
    { peripheral: 'FSPI', signal: 'Q', af: 2, type: 'spi' },
    { peripheral: 'ADC1', signal: 'CH2', af: null, type: 'adc' }
  ])
  // flash pad:pad 名作别名,功能保留原名
  assert.equal(byPrimary.GPIO12.aliases[0], 'SPIHD')
  assert.deepEqual(byPrimary.GPIO12.functions[0], { peripheral: 'SPI1', signal: 'HD', af: 0, type: 'spi' })
  // UART pad 名作别名
  assert.equal(byPrimary.GPIO20.aliases[0], 'U0RXD')
  const touch = byPrimary.GPIO20.functions.find((f) => f.peripheral === 'TOUCH')
  assert.deepEqual(touch, { peripheral: 'TOUCH', signal: 'CH1', af: null, type: 'adc' })
})

test('overlay flags 传播到 pin.flags;非 GPIO 脚分类', () => {
  assert.deepEqual(byPrimary.GPIO2.flags, ['strapping'])
  assert.deepEqual(byPrimary.GPIO6.flags, ['jtag'])
  assert.deepEqual(byPrimary.GPIO12.flags, ['flash'])
  assert.equal(byPrimary.VDD3P3.type, 'power')
  assert.equal(byPrimary.XTAL_N.type, 'clock')
  assert.equal(byPrimary.GND.type, 'ground')
})

test('routing:信号名拆分 + defaultGpio join', () => {
  assert.equal(doc.routing.model, 'gpio-matrix')
  const scl = doc.routing.signals.find((s) => s.peripheral === 'I2C0' && s.signal === 'SCL')
  assert.equal(scl.direction, 'in')
  const spiq = doc.routing.signals.find((s) => s.signal === 'Q' && s.peripheral === 'SPI1')
  assert.ok(spiq, 'SPIQ out 信号应映射到 SPI1')
})

test('overlay 引用不存在的 GPIO → 抛错(由 source 记为 normalise failure)', () => {
  assert.throws(() => normalizeEsp({
    target: 'esp32c3', parsed, overlay,
    pkg: { ...overlay.packages[0], pinMap: { '1': 'GPIO99' } },
    vendorName: 'x', upstreamMeta: { primary: {}, overlay: {} }
  }), /does not exist on target/)
})

test('文档骨架与 ST 输出同构', () => {
  assert.equal(doc.schemaVersion.startsWith('1.'), true)
  assert.equal(doc.chip, 'ESP32-C3-TEST8')
  assert.equal(doc.die, 'esp32c3')
  assert.equal(doc.pinCount, 8)
  assert.equal(doc.memory.ioCount, 5)
  assert.deepEqual(doc.parts[0], { mpn: 'ESP32-C3TEST', status: 'Active', temperature: [-40, 105] })
})
