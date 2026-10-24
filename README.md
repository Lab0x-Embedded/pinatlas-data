# pinatlas-data

PinAtlas 的统一芯片引脚数据集：把上游原始数据转成**一套固定格式的 JSON**，供 [PinAtlas](https://github.com/Lab0x-Embedded/pinatlas) 前端直接读取。当前覆盖 **STMicroelectronics STM32** 与 **Espressif ESP32** 两个厂商。

每周一 UTC 03:17 由 GitHub Actions 自动同步，也可手动触发（Actions → sync-data → Run workflow）。

## 上游与分工

**ST（STM32）**

| 角色 | 仓库 | 提供什么 |
|---|---|---|
| 主源 | [LibrePCB/stm-db](https://github.com/LibrePCB/stm-db) | 每脚的**全部复用功能**、引脚类型、多封装分组、引脚重映射变体、订货号 |
| 补源 | [embassy-rs/stm32-data-generated](https://github.com/embassy-rs/stm32-data-generated) | **AF 号**（外设→引脚→af，反向 join 回主源）、寄存器/RCC/中断/DMA 元数据（预留给代码生成） |

两个上游都不完整，实测：`stm-db` 有、embassy 没有的型号 117 个；embassy 有、stm-db 没有的 190 个。缺 AF 的型号（例如整个 STM32F1 系列）在数据里 `af` 为 `null`，不要当成 0。

**Espressif（ESP32）**

| 角色 | 来源 | 提供什么 |
|---|---|---|
| 主源 | [espressif/esp-idf](https://github.com/espressif/esp-idf)（pin 到最新稳定 release） | `io_mux_reg.h` 的 pad↔GPIO↔IOMUX 功能选择表（= ESP 版 AF 号）、`gpio_sig_map.h` 的 GPIO 矩阵信号表、ADC/touch 固定通道 |
| overlay | 本仓库 `scripts/sources/espressif/data/targets/`（手工维护） | 封装/模组**物理脚号**（datasheet 抄录，每份带出处）、strapping/flash/USB/JTAG 标记 |

ESP32 没有 ST 式的 AF 号：IOMUX 固定功能带 `MCU_SEL` 选择值（schema v1.4.0 起 `af` 字段泛化为"mux 功能选择值"），其余外设信号经 GPIO 矩阵可路由到任意通用 GPIO，放 chip 级 `routing.signals`（不逐 pin 展开）。

## 数据布局

```
data/
  index.json                     清单：vendors.{st,espressif} 各自的上游 ref/总量/分片（顶层旧字段镜像 st 段，前端兼容）
  index/st/STM32F1.json          按厂商+系列分片的索引（型号/封装/引脚数/flash/mpns）
  index/espressif/ESP32-C3.json
  st/STM32F1/STM32F103C8Tx.json        一个封装一个文件（统一 JSON）
  espressif/ESP32-C3/ESP32-C3-QFN32.json
  meta.json                       本次同步的统计、失败清单、AF 覆盖率（分厂商段 + 聚合）
```

前端用法（固定 tag，不要跟 `main`，否则 jsDelivr 缓存会滞后）：

```js
const base = 'https://cdn.jsdelivr.net/gh/Lab0x-Embedded/pinatlas-data@<tag>/data'
const index = await (await fetch(`${base}/index/st/STM32F1.json`)).json()
const chip  = await (await fetch(`${base}/${index.chips[0].part}`)).json()
```

单型号文件平均 12 KB、gzip 后约 2.4 KB，按需加载即可；`index.json` 全量约 250 KB（建议按系列分片加载）。

## 本地运行

```bash
node scripts/sync.mjs                                        # 全部厂商（ST 约 240 MB 下载 + ESP32 少量 header）
node scripts/sync.mjs --vendor st --line STM32F1 --limit 40 --af   # 只跑 ST 小范围
node scripts/sync.mjs --vendor espressif --ref ESP32-C3-QFN32      # 只跑 ESP32 单个封装
node scripts/sync.mjs --dry-run --line STM32F1              # 只转换+校验，不写盘
```

需要 Node ≥ 22，**零依赖**。网络层默认走 `curl`（Node 的 `fetch` 不认 `HTTPS_PROXY`，而本机/CI 两种环境都要能跑）；`--fetch` 可切回内置 fetch。

常用参数：`--vendor`（all 或逗号列表）、`--line`、`--ref`、`--concurrency`、`--tries`、`--out`、`--no-af`、`--primary-sha` / `--enrichment-sha`（指定上游 commit）、`--json`（机器可读摘要）。

ESP32 覆盖:10/10 target(ESP32/S2/S3/C2/C3/C5/C6/C61/H2/P4),21 个封装/模组条目(裸片封装全量 + C3-MINI-1、S3-WROOM-1、C6-WROOM-1 模组);WROOM-32E/WROVER-E 等其余模组的 datasheet 已迁移到 Espressif 新文档平台,后续按同格式补充。封装脚号抄自各 target 的 datasheet,出处记录在 overlay JSON 的 `source` 字段。

## 设计约束（都是实测踩出来的）

- **上游按 commit sha 固定**，不用分支：jsDelivr 对分支 URL 有缓存，会出现同一 URL 内容不一致。
- **失败不覆盖好数据**：单个型号下载或校验失败 → 跳过并写进 `meta.json`，进程退出码非 0（CI 变红）。
- **只写变化的文件**：按字节比对，安静的周只有 `meta.json` 更新（也正好当心跳，避免 Actions 定时任务 60 天未活动被停用）。
- **每个封装一个文件**：`package` 在上游是文件级 1:1，`data/stm-db` 一个文件就是一个封装，不是"一颗芯片多个封装"。

## 校验与已知坑

同步时逐文件断言（详见 [docs/data-report.md](docs/data-report.md)）：

- 引脚重映射变体按 `position` 合并后必须无重复（上游 14% 的线性封装文件会出现同一 position 多条记录，如 LQFP32 却有 36 条）；
- 非网格封装的 position 必须是连续 `1..N`，网格封装必须是 `A1/B7` 形式且不越界；
- 封装名尾数（`LQFP48`）与引脚数一致性、QFP 四边均分、双列偶数检查 → 不通过记 warning。

## 来源与许可

脚本 MIT（见 LICENSE）。ST 数据是 ST 文档衍生的技术信息：主源仓库声明其数据"probably do not fall under copyright"，补源生成仓库没有 LICENSE 文件。ESP32 数据来自 esp-idf 头文件（Apache-2.0 OR MIT）与 Espressif datasheet 抄录的封装脚号（事实性引脚分配）。本仓库仅做格式转换与再分发，版权归各自厂商；详见 [NOTICE](NOTICE)。
