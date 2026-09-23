# 统一 JSON Schema（v1.3.0）

前端只读这一套格式；上游差异全部由 `scripts/lib/normalize.mjs` 吃掉。

## 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 当前 `1.3.0`（`normalize.mjs` 的 `SCHEMA_VERSION` 单点定义，芯片文档 / 索引 / 清单 / meta.json 同源） |
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
    { "peripheral": "EXTI", "signal": "EXTI9", "af": null, "type": "exti", "system": true },
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
`uart`（USART*/UART*/LPUART*）、`can`（CAN*/FDCAN*）、`usb`（USB*/OTG*）、`exti`（EXTI 外部中断线）、
`system`（RCC* 等）、其余 `other`（DAC/ETH/SDMMC/QUADSPI 等暂归 `other`，枚举后续可扩）。

`GPIO` 之外的每个 signal token 拆成 `{peripheral, signal}`，第一段下划线前是外设：

- `TIM2_CH1` → `TIM2` / `CH1`
- `ADC1_PDM_CLK`、`ETH1_MII_RX_CLK` → 拆第一个下划线（`signal` 保留剩余部分）
- `CEC`、`AUDIOCLK`、`BOOTFAILN` → 无下划线，`signal` 为空
- `GPIO` → 丢弃（前端默认"可作普通 GPIO"，不占功能列表位置）
- `RCC_*` / `SYS_*` → 保留但标 `system: true`，前端单独分组（不是可配置外设）
- `ADC1_EXTI11`、`DAC_EXTI9`、`SDADC1_EXTI15` → **不能**按第一个下划线拆（v1.2.0 的改动，见下）

### v1.2.0 的改动：`XXX_EXTIn` 归一成独立 EXTI 外设

上游旧家族把「模拟能力 + EXTI 线」写成了一个 token（全库 63979 个，只有 5 种形态：
`ADC#_EXTI#` 48292、`DAC#_EXTI#` 10198、`DAC_EXTI#` 3715、`ADC_EXTI#` 1435、`SDADC#_EXTI#` 339）。
v1.1.0 按原样拆 → 详情面板出现 `DAC` 组下挂 `EXTI9` 这种假分组（STM32F407 的 PB9）。

实测依据：

| 结论 | 证据 |
|---|---|
| token 里的数字是 **EXTI 线号 = 引脚序号** | 63979 个里 63977 个成立；唯二例外是 STM32U5 的 PC5 → `DAC1_EXTI9` |
| 前缀外设常常在该脚上并不存在 | 上游 ST 原文 `mcu/STM32F407V(E-G)Tx.xml` 里 PB9 就是 `<Signal Name="DAC_EXTI9"/>`，而 F407 的 DAC 输出只有 `DAC_OUT1/OUT2`（PA4/PA5）；PA11 挂 `ADC1/2/3_EXTI11` 但 PA11 不是 ADC 输入（ADC1_IN11 是 PC1） |
| 丢掉前缀不丢信息 | 真模拟通道另有 `ADCn_INm` token（PC4 = `ADC1_IN14`），前缀只是旧库生成时的分组残留 |
| EXTI 永远没有 AF 号 | embassy 生成物里 `EXTI` 外设的 `pins` 恒为空（抽 9 个家族验证） |

归一规则：`/^(?:[A-Z]*ADC\d*|SDADC\d*|DAC\d*)_EXTI(\d+)$/` → `{peripheral:'EXTI', signal:'EXTI9', type:'exti', system:true}`。

- `system: true` 的理由与 `RCC_/SYS_` 一致：EXTI 线没有一套可配置的外设寄存器，也永远拿不到 AF，不应计入 AF 覆盖统计，也不该出现在 `meta.json.afUnmatchedTop` 里当"待补别名"。
- 同一引脚上同一条线号会重复出现（18781 个引脚挂了 2~3 个前缀不同的同线号 token），`compactSignals()` 按 `peripheral|signal` 去重。
- 只重标上游真实存在的 token，**不**替未标注的 GPIO 推演 `EXTIn`（那会凭空多出 20 万+ 条功能项）。

前端消费：`type: 'exti'` 的组单独成块（排序在可配置外设之后、`RCC/SYS` 之前），徽标文案「外部中断」。

### 索引（`index.json` + `index/st/<family>.json`）

前端首屏只拉这两级：`index.json` 给 27 个家族分片清单（`shards[]` 的 `{family, count, path}`），
家族分片给该家族的型号条目。条目字段（v1.3.0）：

| 字段 | 说明 |
|---|---|
| `chip` | 唯一 id（= 文件名）；列表主名必须用它，`displayName` 有 24% 重复 |
| `displayName` / `line` / `die` | 展示名 / 子系列 / die（die 是"封装切换"的分组键） |
| `package` / `packageKind` / `pinCount` / `flashKb` | 列表副标题与筛选用 |
| `mpns` | **v1.3.0 新增**：该型号的订货号（`parts[].mpn`，去重，可省略）。用户常按芯片丝印搜（`STM32F103C8T6` / `C8T6`），而 `chip` 是带通配后缀的 ref（`STM32F103C8Tx`），只靠 chip/displayName 搜不到。实测 2737/2781 型号有 mpn、全库 5034 条（平均 1.8、最多 8），索引涨 83 KB（551 → 634 KB） |
| `part` | 芯片详情文件路径（`st/<family>/<chip>.json`） |

### AF 号

只可能来自 embassy 补源，规则：

- join 键：`pad|TOKEN`（token 如 `I2C1_SCL`），embassy 侧 `peripheral + signal` 拼接后匹配；
- 别名：I2S 家族（embassy 记在 `SPI<n>` 下：`SPI1 + I2S_CK` → `I2S1_CK`/`I2S1_SCK`），外设别名表 `FSMC↔FMC`、`SDIO↔SDMMC`、`ETH↔ETH1`；
- 拿不到时为 `null`（**不是 0**）。整片 STM32F1 都是 null，因为 embassy 对 F1 没有 AF 数据；
- 每次同步把未匹配 token 的前 40 个写进 `meta.json.afUnmatchedTop`，用于继续补别名。EXTI 线不参与（见 v1.2.0 的改动），所以这份清单只留真正待补的别名。
