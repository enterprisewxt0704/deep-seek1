# 测试

这些脚本不依赖真实的 DSH 进程：用临时目录造数据，直接导入插件模块执行。

## 运行环境

- Node.js（本机为 DSH 自带 runtime）：`C:\Users\wuxuanting\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 在仓库根目录执行下文命令；脚本内的模块路径为相对路径，移动仓库后依然有效。

## unit/（纯函数与索引）

| 脚本 | 覆盖内容 |
| --- | --- |
| `selftest.mjs` | `formatClock` / `slugify` / 加权骰分布（2 万次）/ `resolveOutcome` / `normalizeState` / 存档写读往返 |
| `libtest.mjs` | `buildLibrarySync` 扫描团文件与存档、排序、saveCount |
| `projtest.mjs` | 投影定义 `buildProjectionDefinition()` 的 `init`（按 cwd 播种团索引、不自动挂团）与 `apply` 折叠 `tool/result.meta.trpg` |
| `setuptest.mjs` | 开局流程纯函数：20 问问卷完整性/默认值、快速填写、模板选择、购点校验、随机属性（d20/2d6/narrative）、人物卡校验、地点预算与随机、阶段提示 |

## integration/（需要临时工作区）

| 脚本 | 覆盖内容 |
| --- | --- |
| `fixcheck.mjs` | 旧版 `.trpg/state.json` 同步迁移、旧存档按团名接回、`trpg_campaigns op=list` 空/非空分支、包含名 `open`、无效团名报错 |
| `tooltest.mjs` | 12 个工具离线全链路：建团/角色/场景/骰子/掷骰/时间/团史/存档/读档/删档/切团，以及两会话团隔离 |
| `flowtest.mjs` | 开局流程工具链：新团问卷 → 记录 20 答 → 世界 → 购点车卡 → 地点购点 → 第一幕，含阶段门禁、restart/skip、团文件落盘 |

## 命令

```bash
node tests/unit/selftest.mjs
node tests/unit/libtest.mjs
node tests/unit/projtest.mjs
node tests/unit/setuptest.mjs
node tests/integration/fixcheck.mjs
node tests/integration/tooltest.mjs
node tests/integration/flowtest.mjs
```

预期输出：每个脚本打印 `ok`（或包含 `"ok":true` 的 JSON），退出码 0。

## 说明

离线运行时 `@deepseek-ai/dsh-tools` 不可用（`process.resourcesPath` 为空），插件会打印一条 `defineTool 不可用` 的警告并跳过 schema 方言编译——这是预期行为，工具体仍可执行，不影响断言。
