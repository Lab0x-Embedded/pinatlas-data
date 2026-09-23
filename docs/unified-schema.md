# 统一 JSON Schema（v1.1.0）

前端只读这一套格式；上游差异全部由 `scripts/lib/normalize.mjs` 吃掉。

## 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 当前 `1.1.0` |
| `vendor` | string | `STMicroelectronics` |
| `chip` | string | 上游 ref（= stm-db 文件名），如 `STM32F103C8Tx`。**一个封装一个 id**，不是"一颗芯片" |
| `displayName` | string | 上游展示名，如 `STM32F103C(8-B)Tx` |
| `family` / `line` | string\|null | `STM32F1` / `STM32F103` |
| `die` | string\|null | 上游 die 标识（`DIE410`）。**密度+外设集相同的一组 ref 共享一个 die**，是"封装切换"的分组键 |
| `package` | string | `LQFP48` / `TFBGA361` / `WLCSP49` … |
| `packageKind` | `quad`\|`dual`\|`grid`\|`unknown` | 决定引脚怎么摆：四边/双列/网格 |
| `pinCount` | number | **合并变体后的物理引脚数**（不是上游数组长度） |
| `memory` | object | `flashKb` `ramKb` `ioCount` `voltage` `temperature` |
| `parts` | array | 订货号 `mpn` + `status`（Active/Proposal…）+ 温度区间 |
| `source` | object | 上游仓库与 commit，便于追溯 |
| `pins` | array | 见下 |

## pin 对象

```json
{
  "position": "7",          // 物理位置：数字=线性引脚号；A1/B7=网格坐标（packageKind=grid）。同文件内唯一
  "primary": "PC13",        // 主显示名（前端图上一律渲染这个）
  "aliases": ["TAMPER", "RTC"],   // 从名字里拆出来的别名；可重复、可省略
  "variantOf": "PA9",       // 可选：引脚重映射标注里指向的另一个 pad（"PA11 [PA9]"）
  "pad": "PC13",            // 焊盘名（= primary，保留字段名兼容旧前端）
  "name": "PC13-TAMPER-RTC",       // 上游原始引脚名，保留可追溯
  "type": "gpio",           // 语义类型，见下表
  "rawType": "I/O",         // 上游原始类型，保留以便追溯
  "osc": true,              // 可选：晶振/时钟相关（名字含 -OSC 或功能含 RCC_OSC*）
  "functions": [
    { "peripheral": "TIM2", "signal": "CH1", "af": 2, "type": "timer" },
    { "peripheral": "RCC",  "signal": "MCO", "af": null, "type": "system", "system": true }
  ],
  "variants": {             // 可选：引脚重映射变体（上游 variant 字段）
    "PINREMAP": {
      "name": "NC",
      "primary": "NC",
      "type": "nc",
      "functions": []
    }
  }
}
```

### 主名 / 别名 / 变体为什么要拆开（v1.1.0 的改动）

上游把三类不同性质的信息塞在一个 `name` 字符串里，直接渲染会出现"一个物理脚两个名字"，而且无法判断哪个才是主名：

| 上游写法 | primary | aliases | variantOf | 说明 |
|---|---|---|---|---|
| `PC13-TAMPER-RTC` | `PC13` | `TAMPER`, `RTC` | | `-` 后缀是"额外功能提示"，不是第二主名 |
| `PA13-JTMS/SWDIO` | `PA13` | `JTMS`, `SWDIO` | | 调试复用也是别名 |
| `VDD/VDDA` | `VDD` | `VDDA` | | 同一物理脚的两个网络名 |
| `VSSA/VREF-` | `VSSA` | `VREF-` | | **负参考的连字符属于名字**，拆分时要保留 |
| `PA11 [PA9]` | `PA11` | | `PA9` | 方括号是重映射标注，不是同一脚的别名 |
| `PDR_ON` | `PDR_ON` | | | 无分隔符，原样为主名 |

规则实现见 `scripts/lib/normalize.mjs` 的 `splitPinName()`（有单测路径：F1 的 `-` 后缀、G0 的 `[ ]`、F4 的 `VREF-`）。

### 语义类型映射（源数据只有 6 个原始值）

| rawType | type | 规则 |
|---|---|---|
| `I/O` | `gpio` | 引脚名含 `-OSC` 或功能含 `RCC_OSC*` → 提升为 `clock`（v1.1.0 起），否则 `gpio` |
| `Power` | `ground` / `power` | 名字以 `VSS` 开头 → `ground`，否则 `power`（`VREF+`/`VCAP*`/`VLXSMPS` 都归 power） |
| `Reset` | `reset` | |
| `Boot` | `boot` | `BOOT0..3`、`BYPASS_REG` |
| `MonoIO` | `mono` | 单功能 I/O：`VREF+`、`DNU`、`PDR_ON`、`DDR_DQ*` |
| `NC` | `nc` | `NC`、`AT0/AT1` |

### functions 的拆分规则

每个 function 除 `peripheral` / `signal` / `af` 外，还有 `type`（分组用，原始外设名保留，信息不丢）：
`adc`（ADC*）、`timer`（TIM*/LPTIM*/HRTIM*）、`spi`（SPI*/I2S*/SAI*）、`i2c`（I2C*/I3C*）、
`uart`（USART*/UART*/LPUART*）、`can`（CAN*/FDCAN*）、`usb`（USB*/OTG*）、`system`（RCC* 等）、其余 `other`
（DAC/ETH/SDMMC/QUADSPI 等暂归 `other`，枚举后续可扩）。

`GPIO` 之外的每个 signal token 拆成 `{peripheral, signal}`，第一段下划线前是外设：

- `TIM2_CH1` → `TIM2` / `CH1`
- `ADC1_PDM_CLK`、`ETH1_MII_RX_CLK` → 拆第一个下划线（`signal` 保留剩余部分）
- `CEC`、`AUDIOCLK`、`BOOTFAILN` → 无下划线，`signal` 为空
- `GPIO` → 丢弃（前端默认"可作普通 GPIO"，不占功能列表位置）
- `RCC_*` / `SYS_*` → 保留但标 `system: true`，前端单独分组（不是可配置外设）
- `ADC1_EXTI11` 这类"挂在某外设前缀下的 EXTI"按原样拆，前端显示原 token 即可

### AF 号

只可能来自 embassy 补源，规则：

- join 键：`pad|TOKEN`（token 如 `I2C1_SCL`），embassy 侧 `peripheral + signal` 拼接后匹配；
- 别名：I2S 家族（embassy 记在 `SPI<n>` 下：`SPI1 + I2S_CK` → `I2S1_CK`/`I2S1_SCK`），外设别名表 `FSMC↔FMC`、`SDIO↔SDMMC`、`ETH↔ETH1`；
- 拿不到时为 `null`（**不是 0**）。整片 STM32F1 都是 null，因为 embassy 对 F1 没有 AF 数据；
- 每次同步把未匹配 token 的前 40 个写进 `meta.json.afUnmatchedTop`，用于继续补别名。
