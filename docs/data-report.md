# 数据调查报告（实测）

本文件记录选型与转换规则的**实测依据**。所有数字都是在本项目管线上跑出来的，不是估计值；复现命令见文末。

## 1. 上游规模与活跃度

| | LibrePCB/stm-db（主源） | embassy-rs/stm32-data-generated（补源） |
|---|---|---|
| 数据文件 | **2952** 个 JSON（STM32 2781 / STM8 171） | **1616** 个 chip JSON + **458** 个 register JSON |
| 粒度 | **一个封装一个文件** | **一个 die 一个文件**，内含 `packages[]` |
| 体积 | 平均 27 KB，全量约 **78 MB** | chips 合计 **239 MB**（平均 152 KB，最大 0.5 MB） |
| 最近提交 | **2026-06-29**（跟随 STM32CubeMX 6.17.0，补订货号） | **2026-09-14**；近 90 天 **34** 次提交 |
| LICENSE | `LICENSE.txt`（脚本 MIT）+ README 声明数据"probably do not fall under copyright" | **根目录没有 LICENSE**（仓库根只有 README/.gitignore） |

## 2. 两个源能对上多少（键：`stm-db.names.rpn` ↔ embassy 文件名）

| 指标 | 数量 |
|---|---|
| stm-db 推导出的 rpn | 1543 |
| embassy chip 文件 | 1616 |
| **交集** | **1426** |
| stm-db 独有 | **117** |
| embassy 独有 | **190**（如 STM32C531 系列） |

结论：两个源都不能单独覆盖全部型号，`index.json` 必须允许型号缺 AF/缺数据，不要假装全都有。

## 3. AF 号能不能补齐（join 实测，8 个型号）

| 型号 | embassy AF 条目 → 命中 stm-db | stm-db 外设 token → 拿到 AF |
|---|---|---|
| STM32G071RB | 256/276 (92.8%) | 250/355 |
| **STM32F103C8** | **0** | **0/108** |
| STM32F401RE | 117/135 (86.7%) | 115/157 |
| STM32L432KC | 128/128 (100%) | 127/161 |
| STM32H743ZI | 754/822 (91.7%) | 752/987 |
| STM32F407VG | 296/314 (94.3%) | 290/388 |
| STM32G474RE | 363/379 (95.8%) | 361/583 |
| STM32L073RZ | 230/237 (97.0%) | 229/281 |
| **合计** | **2144/2291 = 93.6%** | **2124/3020 = 70.3%** |

- 未命中的约 7% 集中在 **I2S**：embassy 记在 `SPI<n>` 下（`SPI2_I2S_CK`），stm-db 写作 `I2S2_CK` / `I2S2_SCK`。已内置别名规则，其余进 `meta.json.afUnmatchedTop`。
- **STM32F1 完全没有 AF 数据**（F103 实测 0 条）→ 该系列 `af` 恒为 `null`，需要人工补或从数据手册/AF 表导入。

## 4. 上游结构坑（决定转换规则）

### 4.1 `pinout` 不是"一针一条" —— 14% 的线性文件会被画错
372 个线性封装文件中 **53 个**存在重复 `position`。实例 **STM32G031K8Tx（LQFP32）** 有 **36 条**记录：

```
position 19  ×2 → {"name":"PA9","variant":null} + {"name":"NC","variant":"PINREMAP"}
position 22  ×2 → {"name":"PA11 [PA9]","variant":null} + {"name":"PA9 [PA11]","variant":"PINREMAP"}
```

→ 直接按数组长度画会在 32 脚封装上画出 36 个引脚。转换器按 `position` 合并，变体进 `variants`。

### 4.2 `position` 有两种形态，网格占一半以上
486 文件 / 54365 引脚的采样：

| 形态 | 占比 | 说明 |
|---|---|---|
| 数字 `1..N` | 45% | QFP / QFN / TSSOP 等，可按约定摆位（四边均分、pin1 左上、逆时针） |
| 网格 `A1/B7` | 55% | BGA / WLCSP，**不能按 √N 推行列** |

网格封装里 **91/201 是稀疏矩阵**：`UFBGA100` 是 12×12 网格只有 100 球、`TFBGA216` 是 15×15 只有 216 球 → 行列必须取 position 的字母/数字极值。

**大封装的 position 会混用三种编码**（实测 `TFBGA361` / STM32MP151AACx，361 球）：

| 形态 | 数量 | 例 |
|---|---|---|
| 单字母行 | 220 | `A1` `A23` |
| 双字母行 | 64 | `AA1` `AC12` |
| 数字前缀行 | 77 | `1J3` `1J8` |

所以校验只要求"能拆成行 + 列"，形态混合记 warning 而不是 fail（第一版把它当错误，导致 64 个 MP 型号被丢弃）。排列是否正确仍需对照数据手册抽验。

### 4.3 `package` 是文件级 1:1，"封装切换" = 切文件
50/50 采样的文件只有一个 `package`。`STM32F103` 有 **49 个 ref、归到 4 个 die**：

| die | 密度 | 覆盖的封装 |
|---|---|---|
| `DIE410` | 64 KB | VFQFPN36, LQFP64, TFBGA64, LQFP100, LFBGA100, UFBGA100（9 个 ref） |
| `DIE412` | 16 KB | VFQFPN36 |
| `DIE414` | 256 KB | LQFP64, WLCSP64, LQFP100, LFBGA100, LQFP144, LFBGA144（18 个 ref） |
| `DIE430` | 768 KB | LQFP64, LQFP100, LQFP144, LFBGA144 |

→ `die` 是"密度+外设集"，**不是芯片**；型号前缀也不是（F103 下有 49 个）。索引按 `line → die → 封装列表` 组织。

### 4.4 封装种类很多，且多数是网格
486 文件采样共 **86 种封装串**：quad 类 21（LQFP32/48/64/100/144/176、UFQFPN28/32/48…）、**grid 类 56**（UFBGA64/100/132/169/176、TFBGA216/361/436、LFBGA289、WLCSP49…）、dual 类 5（TSSOP20 等）、VFQFPN 4。

→ 引脚图至少要三套布局引擎（quad/dual/grid）+ 一张封装几何表；上游**没有 pitch、本体尺寸、视角（俯视/底视）**。

### 4.5 引脚类型只有 6 个原始值
54365 引脚采样：`I/O` 36805、`Power` 11854、`MonoIO` 4498、`Reset` 512、`Boot` 349、`NC` 347。

`Power` 里按名字分：`VSS*` 5165（地）、`VDD*/VBAT/VDDA` 5795、其余 894（`VREF+` 148、`VCAP*`、`VLXSMPS`、`VDDUSB`、`RFU`…）。`MonoIO` 是单功能 I/O（`VREF+`、`DNU`、`PDR_ON`、`DDR_DQ*`）。

→ 上游**没有** `ground`/`clock`/`analog` 类型；`ground` 靠名字推，`clock` 用 `osc` 标记表达。

### 4.6 signal token 的例外清单
24002 个 token / 1589 唯一：

- 无下划线：`GPIO`(3400)、`CEC`、`AUDIOCLK`、`BOOTFAILN`
- 前缀与语义不符：`ADC1_EXTI11/15`（其实是 EXTI）
- 多下划线：`ETH1_MII_RX_CLK`、`ADC1_PDM_CLK`（拆第一个下划线即可）
- 差分负端：`ADC1_INN10`
- 非外设前缀：`RCC_`(354)、`SYS_`(311)
- 别名：`FSMC`(F1) ↔ `FMC`(F4+)、`I2S2_CK` ↔ `SPI2_I2S_CK`

### 4.7 embassy 的另一面
- **GPIOx 外设的 pins 全空**（112 个 GPIO 外设，0 个有 pins）→ 不能当引脚源；
- `packages[]` 多数只列 1 个封装（16 个芯片采样：1 个封装 10、2 个 4、3 个 2）→ 封装信息以主源为准；
- `docs[]` 带 ST 官方手册链接、`memory[]` 带电地址与擦写粒度、`peripherals[]` 带 RCC/中断/DMA —— 这些是将来代码生成的素材。

## 5. CDN 可靠性（为什么必须"抓一次落库"）

| 场景 | 结果 |
|---|---|
| 并行直抓 49 个 stm-db 文件（无重试） | **12 个静默失败（24%）**，复测 HTTP 200 → 纯抖动 |
| 10 并发 + 3 次重试 + JSON 校验（492 个文件） | 486 成功，**6 个仍失败（1.2%）** |

→ 前端不该在运行时依赖 jsDelivr 拉上游；本仓库固定上游 commit 抓取、校验、落盘，前端只读本仓库的 tag。

## 6. 产物体积

| | 原始 | 转换后 | gzip |
|---|---|---|---|
| 单文件 | 27 KB | **12 KB** | 2.4 KB |
| 全量 | 78 MB | **34 MB** | 6.9 MB |
| index（全量） | — | 255 KB | 32 KB |

## 7. 复现命令

```bash
# 上游文件清单与体积
gh api 'repos/LibrePCB/stm-db/git/trees/master?recursive=1'   --jq '.tree[] | select(.type=="blob") | .path'
gh api 'repos/embassy-rs/stm32-data-generated/git/trees/main?recursive=1'

# 小范围转换 + 校验（不写盘）
node scripts/sync.mjs --dry-run --line STM32F1 --limit 40 --af --json

# 看某型号的引脚重复/变体情况
node -e "fetch('https://cdn.jsdelivr.net/gh/LibrePCB/stm-db@master/data/STM32G031K8Tx.json').then(r=>r.json()).then(d=>console.log(d.package, d.pinout.length, new Set(d.pinout.map(p=>p.position)).size))"
# → LQFP32 36 32
```

## 8. 许可与归属

- 主源数据：STM32CubeMX / STM8CubeMX 数据库导出，仓库 README 声明"只含数据手册里也能得到的技术信息，probably 不受版权保护"；脚本 MIT。
- 补源生成物：源自 `embassy-rs/stm32-data`，**没有随仓库发布 LICENSE**，只能标注来源。
- 本仓库：脚本 MIT；数据仅做格式转换与整理，版权归 **STMicroelectronics**，不暗示其背书。
