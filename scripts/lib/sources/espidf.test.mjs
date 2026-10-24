// esp-idf header parsers — fixtures are verbatim excerpts of esp-idf v5.5.1
// components/soc/{esp32c3,esp32}/… so a formatting change upstream fails here first.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseIoMuxReg, parseGpioSigMap, parseAdcChannels, parseTouchChannels, parseSocCaps
} from './espidf.mjs'

const C3_IO_MUX = `
#define IO_MUX_GPIO0_REG\t\tPERIPHS_IO_MUX_XTAL_32K_P_U
#define IO_MUX_GPIO2_REG\t\tPERIPHS_IO_MUX_GPIO2_U
#define IO_MUX_GPIO5_REG\t\tPERIPHS_IO_MUX_MTDI_U
#define IO_MUX_GPIO6_REG\t\tPERIPHS_IO_MUX_MTCK_U
#define IO_MUX_GPIO11_REG\tPERIPHS_IO_MUX_VDD_SPI_U
#define IO_MUX_GPIO15_REG\tPERIPHS_IO_MUX_SPICLK_U
#define IO_MUX_GPIO21_REG\tPERIPHS_IO_MUX_U0TXD_U

#define SPI_CLK_GPIO_NUM 15
#define MAX_PAD_GPIO_NUM 21
#define SD_CMD_GPIO_NUM 11
#define USB_INT_PHY0_DM_GPIO_NUM   18

#define PERIPHS_IO_MUX_XTAL_32K_P_U       (REG_IO_MUX_BASE +0x04)
#define FUNC_XTAL_32K_P_GPIO0                       1
#define FUNC_XTAL_32K_P_GPIO0_0                     0

#define PERIPHS_IO_MUX_GPIO2_U            (REG_IO_MUX_BASE +0x0c)
#define FUNC_GPIO2_FSPIQ                            2
#define FUNC_GPIO2_GPIO2                            1
#define FUNC_GPIO2_GPIO2_0                          0

#define PERIPHS_IO_MUX_MTDI_U             (REG_IO_MUX_BASE +0x18)
#define FUNC_MTDI_FSPIWP                            2
#define FUNC_MTDI_GPIO5                             1
#define FUNC_MTDI_MTDI                              0

#define PERIPHS_IO_MUX_MTCK_U             (REG_IO_MUX_BASE +0x1c)
#define FUNC_MTCK_FSPICLK                           2
#define FUNC_MTCK_GPIO6                             1
#define FUNC_MTCK_MTCK                              0

#define PERIPHS_IO_MUX_VDD_SPI_U          (REG_IO_MUX_BASE +0x30)
#define FUNC_VDD_SPI_GPIO11                         1
#define FUNC_VDD_SPI_GPIO11_0                       0

#define PERIPHS_IO_MUX_SPICLK_U           (REG_IO_MUX_BASE +0x40)
#define FUNC_SPICLK_GPIO15                          1
#define FUNC_SPICLK_SPICLK                          0

#define PERIPHS_IO_MUX_U0TXD_U            (REG_IO_MUX_BASE +0x58)
#define FUNC_U0TXD_GPIO21                           1
#define FUNC_U0TXD_U0TXD                            0
`

const ESP32_IO_MUX = `
#define SPI_CLK_GPIO_NUM                            6
#define XTAL32K_P_GPIO_NUM                          32

#define PERIPHS_IO_MUX_GPIO0_U            (DR_REG_IO_MUX_BASE +0x44)
#define IO_MUX_GPIO0_REG                  PERIPHS_IO_MUX_GPIO0_U
#define FUNC_GPIO0_EMAC_TX_CLK                      5
#define FUNC_GPIO0_GPIO0                            2
#define FUNC_GPIO0_CLK_OUT1                         1
#define FUNC_GPIO0_GPIO0_0                          0

#define IO_MUX_GPIO1_REG                  PERIPHS_IO_MUX_U0TXD_U
#define FUNC_U0TXD_EMAC_RXD2                        5
#define FUNC_U0TXD_GPIO1                            2
#define FUNC_U0TXD_CLK_OUT3                         1
#define FUNC_U0TXD_U0TXD                            0

#define IO_MUX_GPIO2_REG                  PERIPHS_IO_MUX_GPIO2_U
#define FUNC_GPIO2_SD_DATA0                         4
#define FUNC_GPIO2_HS2_DATA0                        3
#define FUNC_GPIO2_GPIO2                            2
#define FUNC_GPIO2_HSPIWP                           1
#define FUNC_GPIO2_GPIO2_0                          0
`

test('parseIoMuxReg: esp32c3 — pad map, IOMUX functions, GPIO self-selects dropped', () => {
  const { pads, defaults } = parseIoMuxReg(C3_IO_MUX)
  assert.equal(pads.get(0).pad, 'XTAL_32K_P')
  assert.equal(pads.get(2).pad, 'GPIO2')
  assert.equal(pads.get(6).pad, 'MTCK')
  // 只有 GPIO 自选功能的 pad(晶体脚)功能列表为空
  assert.deepEqual(pads.get(0).functions, [])
  assert.deepEqual(pads.get(6).functions.map((f) => [f.name, f.sel]), [['MTCK', 0], ['FSPICLK', 2]])
  assert.deepEqual(pads.get(2).functions.map((f) => [f.name, f.sel]), [['FSPIQ', 2]])
  assert.deepEqual(pads.get(21).functions.map((f) => [f.name, f.sel]), [['U0TXD', 0]])
  // _0 重复别名宏不产生额外功能;MAX_* 不进 defaults
  assert.deepEqual(defaults, [
    { signal: 'SPI_CLK', gpio: 15 },
    { signal: 'SD_CMD', gpio: 11 },
    { signal: 'USB_INT_PHY0_DM', gpio: 18 }
  ])
})

test('parseIoMuxReg: legacy esp32 — same shape, GPIO self-select value is 2 here', () => {
  const { pads, defaults } = parseIoMuxReg(ESP32_IO_MUX)
  assert.equal(pads.get(0).pad, 'GPIO0')
  assert.equal(pads.get(1).pad, 'U0TXD')
  assert.deepEqual(pads.get(0).functions.map((f) => [f.name, f.sel]), [['CLK_OUT1', 1], ['EMAC_TX_CLK', 5]])
  assert.deepEqual(pads.get(1).functions.map((f) => [f.name, f.sel]), [['U0TXD', 0], ['CLK_OUT3', 1], ['EMAC_RXD2', 5]])
  assert.deepEqual(pads.get(2).functions.map((f) => [f.name, f.sel]), [['HSPIWP', 1], ['HS2_DATA0', 3], ['SD_DATA0', 4]])
  assert.deepEqual(defaults, [
    { signal: 'SPI_CLK', gpio: 6 },
    { signal: 'XTAL32K_P', gpio: 32 }
  ])
})

// esp-idf v6 (C5+) 把 pad 别名宏改成了 PERIPHS_IO_MUX_U_PAD_<名>(无 _U 尾缀)
const C5_IO_MUX = `
#define IO_MUX_GPIO2_REG                    PERIPHS_IO_MUX_U_PAD_MTMS
#define IO_MUX_GPIO6_REG                    PERIPHS_IO_MUX_U_PAD_GPIO6
#define USB_INT_PHY0_DM_GPIO_NUM              13
#define FUNC_MTMS_FSPIQ                                                    2
#define FUNC_MTMS_GPIO2                                                  1
#define FUNC_MTMS_MTMS                                                    0
#define FUNC_GPIO6_GPIO6                                                    1
#define FUNC_GPIO6_GPIO6_0                                                  0
`

test('parseIoMuxReg: v6 U_PAD 宏形式(C5+)', () => {
  const { pads } = parseIoMuxReg(C5_IO_MUX)
  assert.equal(pads.get(2).pad, 'MTMS')
  assert.equal(pads.get(6).pad, 'GPIO6')
  assert.deepEqual(pads.get(2).functions.map((f) => [f.name, f.sel]), [['MTMS', 0], ['FSPIQ', 2]])
  assert.deepEqual(pads.get(6).functions, [])
})

const C3_SIG_MAP = `
#define SPICLK_OUT_MUX_IDX            SPICLK_OUT_IDX
#define SPICLK_IN_IDX                   0
#define SPICLK_OUT_IDX                  0
#define SPIQ_IN_IDX                     1
#define SPIQ_OUT_IDX                    1
#define I2CEXT0_SCL_IN_IDX             60
#define I2CEXT0_SCL_OUT_IDX            45
`

test('parseGpioSigMap: in/out entries with numeric idx; macro aliases skipped', () => {
  const signals = parseGpioSigMap(C3_SIG_MAP)
  assert.equal(signals.length, 6)
  assert.deepEqual(signals[0], { name: 'SPICLK', direction: 'in', idx: 0 })
  const scl = signals.filter((s) => s.name === 'I2CEXT0_SCL')
  assert.deepEqual(scl.map((s) => s.direction).sort(), ['in', 'out'])
})

const C3_ADC = `
#define ADC1_GPIO0_CHANNEL      0
#define ADC1_CHANNEL_0_GPIO_NUM 0
#define ADC1_GPIO4_CHANNEL      4
#define ADC1_CHANNEL_4_GPIO_NUM 4
#define ADC2_GPIO5_CHANNEL      0
#define ADC2_CHANNEL_0_GPIO_NUM 5
`

test('parseAdcChannels: both macro directions collapse to gpio → [{unit, channel}]', () => {
  const adc = parseAdcChannels(C3_ADC)
  assert.deepEqual(adc.get(0), [{ unit: 'ADC1', channel: 0 }])
  assert.deepEqual(adc.get(4), [{ unit: 'ADC1', channel: 4 }])
  assert.deepEqual(adc.get(5), [{ unit: 'ADC2', channel: 0 }])
})

const ESP32_TOUCH = `
#define TOUCH_PAD_GPIO4_CHANNEL     0
#define TOUCH_PAD_NUM0_GPIO_NUM     4
#define TOUCH_PAD_GPIO0_CHANNEL     1
#define TOUCH_PAD_NUM1_GPIO_NUM     0
#define TOUCH_PAD_GPIO15_CHANNEL    3
#define TOUCH_PAD_NUM3_GPIO_NUM     15
`

test('parseTouchChannels: gpio → touch channel index', () => {
  const touch = parseTouchChannels(ESP32_TOUCH)
  assert.equal(touch.get(4), 0)
  assert.equal(touch.get(0), 1)
  assert.equal(touch.get(15), 3)
})

test('parseSocCaps: pin count anchor', () => {
  assert.equal(parseSocCaps('#define SOC_GPIO_PIN_COUNT                 22\n').gpioPinCount, 22)
  assert.equal(parseSocCaps('#define SOC_ADC_SUPPORTED 1\n').gpioPinCount, null)
})
