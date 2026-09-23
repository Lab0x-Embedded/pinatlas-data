// 数据仓库的单元测试（node --test，无需依赖）。
//
// 为什么必须有：pinPad/primary 是 AF join 的键，拆错不会报错、只会让 AF 命中数悄悄变少
// （实测 "PA13 (JTMS/SWDIO)" 被斜杠拆成 "PA13 (JTMS" → STM32L412C8Ux 少 17 个 AF，
// L4/L5/H7/U5/WBA 整个家族的覆盖率一起掉）。所以这里把上游真实出现过的名字形态全部钉住。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { functionType, mapPinType, packageKind, pinPad, splitPinName, splitToken, validateUnified } from './normalize.mjs'

test('splitPinName：连字符后缀是别名', () => {
  assert.deepEqual(splitPinName('PC13-TAMPER-RTC'), { primary: 'PC13', aliases: ['TAMPER', 'RTC'], variantOf: null })
  assert.deepEqual(splitPinName('PA0-WKUP'), { primary: 'PA0', aliases: ['WKUP'], variantOf: null })
  assert.deepEqual(splitPinName('PA13-JTMS/SWDIO'), { primary: 'PA13', aliases: ['JTMS', 'SWDIO'], variantOf: null })
})

test('splitPinName：斜杠是同一脚的第二个网络名', () => {
  assert.deepEqual(splitPinName('VDD/VDDA'), { primary: 'VDD', aliases: ['VDDA'], variantOf: null })
  assert.deepEqual(splitPinName('VSS/VSSA'), { primary: 'VSS', aliases: ['VSSA'], variantOf: null })
})

test('splitPinName：负参考的连字符属于名字', () => {
  assert.deepEqual(splitPinName('VSSA/VREF-'), { primary: 'VSSA', aliases: ['VREF-'], variantOf: null })
})

test('splitPinName：圆括号注释先摘再拆（L4/H7 家族的真实形态）', () => {
  assert.deepEqual(splitPinName('PA13 (JTMS/SWDIO)'), { primary: 'PA13', aliases: ['JTMS', 'SWDIO'], variantOf: null })
  assert.deepEqual(splitPinName('PH0-OSC_IN (PH0)'), { primary: 'PH0', aliases: ['OSC_IN'], variantOf: null })
  assert.deepEqual(splitPinName('PC14-OSC32_IN (PC14)'), { primary: 'PC14', aliases: ['OSC32_IN'], variantOf: null })
})

test('splitPinName：字母+数字后缀（模拟开关脚）主名要取焊盘 token', () => {
  assert.deepEqual(splitPinName('PC2_C'), { primary: 'PC2', aliases: [], variantOf: null })
  assert.deepEqual(splitPinName('PA0_C'), { primary: 'PA0', aliases: [], variantOf: null })
  assert.deepEqual(splitPinName('PB2_BOOT1'), { primary: 'PB2', aliases: ['BOOT1'], variantOf: null })
  assert.deepEqual(splitPinName('PC2_WKUP'), { primary: 'PC2', aliases: ['WKUP'], variantOf: null })
})

test('splitPinName：方括号是重映射标注', () => {
  assert.deepEqual(splitPinName('PA11 [PA9]'), { primary: 'PA11', aliases: [], variantOf: 'PA9' })
})

test('splitPinName：无分隔符原样为主名', () => {
  assert.deepEqual(splitPinName('PDR_ON'), { primary: 'PDR_ON', aliases: [], variantOf: null })
  assert.deepEqual(splitPinName('BOOT0'), { primary: 'BOOT0', aliases: [], variantOf: null })
})

test('pinPad 是 AF join 的键：绝不能带注释残留', () => {
  for (const name of ['PA13 (JTMS/SWDIO)', 'PC14-OSC32_IN (PC14)', 'PA11 [PA9]', 'VDD/VDDA', 'PA0-WKUP']) {
    const pad = pinPad(name)
    assert.match(pad, /^[A-Z][A-Z0-9_+]*$/, `${name} → ${pad}`)
  }
  assert.equal(pinPad('PA13 (JTMS/SWDIO)'), 'PA13')
})

test('类型映射：I/O → gpio，OSC 脚由调用方提升为 clock', () => {
  assert.equal(mapPinType('I/O', 'PA0'), 'gpio')
  assert.equal(mapPinType('Power', 'VDD'), 'power')
  assert.equal(mapPinType('Power', 'VSS'), 'ground')
  assert.equal(mapPinType('Reset', 'NRST'), 'reset')
  assert.equal(mapPinType('MonoIO', 'PDR_ON'), 'mono')
})

test('功能大类派生', () => {
  assert.equal(functionType('ADC1', 'peripheral'), 'adc')
  assert.equal(functionType('TIM2', 'peripheral'), 'timer')
  assert.equal(functionType('I2S1', 'peripheral'), 'spi')
  assert.equal(functionType('LPUART1', 'peripheral'), 'uart')
  assert.equal(functionType('RCC', 'system'), 'system')
  assert.equal(functionType('QUADSPI', 'peripheral'), 'other')
})

test('splitToken：GPIO 单列，系统信号标记', () => {
  assert.deepEqual(splitToken('GPIO'), { kind: 'gpio', peripheral: 'GPIO', signal: '' })
  assert.deepEqual(splitToken('TIM2_CH1'), { kind: 'peripheral', peripheral: 'TIM2', signal: 'CH1' })
  assert.equal(splitToken('RCC_OSC_IN').kind, 'system')
})

test('packageKind：名字与编号形态双判', () => {
  assert.equal(packageKind('LQFP48', ['1', '2']), 'quad')
  assert.equal(packageKind('VQFPN68', ['1', '2']), 'quad')
  assert.equal(packageKind('TSSOP20', ['1', '2']), 'dual')
  assert.equal(packageKind('TFBGA361', ['A1', 'B2']), 'grid')
  // 名字像网格但数据是线性编号（LGA77 模块）→ 只能按线性近似
  assert.equal(packageKind('LGA77', ['1', '2']), 'unknown')
  // 名字不认识但编号是行列坐标 → 按网格
  assert.equal(packageKind('WEIRD99', ['A1', 'B2']), 'grid')
})

test('validateUnified：primary 残留注释要判硬错误', () => {
  const doc = {
    chip: 'X', package: 'LQFP4', die: 'DIE1', packageKind: 'quad',
    pins: [
      { position: '1', name: 'PA0', primary: 'PA0', type: 'gpio', functions: [] },
      { position: '2', name: 'PA13 (JTMS/SWDIO)', primary: 'PA13 (JTMS', type: 'gpio', functions: [] },
    ],
  }
  const { errors } = validateUnified(doc)
  assert.ok(errors.some(e => e.includes('annotation leftovers')), errors.join('; '))
})
