# pinatlas-data

PinAtlas 的统一芯片引脚数据集：把上游原始数据转成**一套固定格式的 JSON**，供 [PinAtlas](https://github.com/Lab0x-Embedded/pinatlas) 前端直接读取。

每周一 UTC 03:17 由 GitHub Actions 自动同步，也可手动触发（Actions → sync-data → Run workflow）。

## 上游与分工

| 角色 | 仓库 | 提供什么 |
|---|---|---|
| 主源 | [LibrePCB/stm-db](https://github.com/LibrePCB/stm-db) | 每脚的**全部复用功能**、引脚类型、多封装分组、引脚重映射变体、订货号 |
| 补源 | [embassy-rs/stm32-data-generated](https://github.com/embassy-rs/stm32-data-generated) | **AF 号**（外设→引脚→af，反向 join 回主源）、寄存器/RCC/中断/DMA 元数据（预留给代码生成） |

两个上游都不完整，实测：`stm-db` 有、embassy 没有的型号 117 个；embassy 有、stm-db 没有的 190 个。缺 AF 的型号（例如整个 STM32F1 系列）在数据里 `af` 为 `null`，不要当成 0。

## 数据布局

```
data/
  index.json                 清单：上游 commit、总量、分片列表
  index/STM32F1.json         按系列分片的索引（型号/封装/引脚数/flash）
  st/STM32F1/STM32F103C8Tx.json   一个封装一个文件（统一 JSON）
  meta.json                  本次同步的统计、失败清单、AF 覆盖率
```

前端用法（固定 tag，不要跟 `main`，否则 jsDelivr 缓存会滞后）：

```js
const base = 'https://cdn.jsdelivr.net/gh/Lab0x-Embedded/pinatlas-data@<tag>/data'
const index = await (await fetch(`${base}/index/STM32F1.json`)).json()
const chip  = await (await fetch(`${base}/${index.chips[0].part}`)).json()
```

单型号文件平均 12 KB、gzip 后约 2.4 KB，按需加载即可；`index.json` 全量约 250 KB（建议按系列分片加载）。

## 本地运行

```bash
node scripts/sync.mjs                                  # 全量同步（约 240 MB 下载）
node scripts/sync.mjs --line STM32F1 --limit 40 --af    # 小范围试跑
node scripts/sync.mjs --ref STM32F103C8Tx --af          # 单个型号
node scripts/sync.mjs --dry-run --line STM32F1          # 只转换+校验，不写盘
```

需要 Node ≥ 20，**零依赖**。网络层默认走 `curl`（Node 的 `fetch` 不认 `HTTPS_PROXY`，而本机/CI 两种环境都要能跑）；`--fetch` 可切回内置 fetch。

常用参数：`--concurrency`、`--tries`、`--out`、`--no-af`、`--primary-sha` / `--enrichment-sha`（指定上游 commit）、`--json`（机器可读摘要）。

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

脚本 MIT（见 LICENSE）。数据是 ST 文档衍生的技术信息：主源仓库声明其数据"probably do not fall under copyright"，补源生成仓库没有 LICENSE 文件。本仓库仅做格式转换与再分发，版权归 STMicroelectronics；详见 [NOTICE](NOTICE)。
