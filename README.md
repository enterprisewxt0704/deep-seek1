# DSH 跑团模式插件（dsh-trpg-mode）

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 桌面版增加一个「跑团模式」：以 AI 为主持人的单人跑团（TRPG）玩法。选这个模式后，右侧栏会出现一张随剧情实时更新的角色/骰点/团史面板，状态以会话投影保存，支持多团互不串线、完整存档管理与自由切换查看。

> 版本：v1.2.1（2026-11-12）。已在 DSH desktop 实测：预设挂载、11 个工具、面板座位、会话投影、跑团专用压缩、存档/切团。

## 功能

- **跑团预设**：新建会话时选择「跑团模式」（B 档，自带跑团专用压缩）或「跑团模式（兼容）」（A 档，使用宿主原生压缩）。
- **世界观开局**：你提供世界观要求（题材、基调、规则、禁忌），主持人据此生成完整设定，写入面板后再创建角色、开始叙事。
- **右侧栏面板**：角色卡、骰点历史、团史摘要、世界设定、存档 / 团管理五个页签；顶部「看哪个团」下拉可自由查看工作区里任意团的概览。
- **11 个工具**（只在跑团会话可见，其余工具被 guard 拒绝）：
  - `trpg_world` 世界观（get / create / update / new 另起新团）
  - `trpg_sheet` 角色卡（create / update / delta / get）
  - `trpg_scene` 当前场景
  - `trpg_roll` 掷骰与判定（支持目标值、成功/失败/大成功/大失败）
  - `trpg_dice` 骰子配置：自定义骰面与**概率权重**、默认骰、列出
  - `trpg_time` 单回合时间跨度（estimate / fixed）、时间推进与设定
  - `trpg_digest` 团史摘要、`trpg_recall` 回读最近状态
  - `trpg_save` 存档（save / list / delete 按文件名、槽位、整团）
  - `trpg_load` 读档（默认读**当前团**最近存档，可按团 / 槽位 / 文件）
  - `trpg_campaigns` 团管理（list / open / new）
- **多团隔离**：每个团一份 `.trpg/campaigns/<团id>.json`，会话→团映射在 `.trpg/sessions/`，不再共用全局 `state.json`；旧版 `state.json` 会一次性迁移成独立团。
- **跑团专用压缩**：B 档继承宿主 `BasicCompactionEngine`，把「当前团的面板状态」附进摘要提示，摘要按团名/角色/线索/未决事项/下一步组织；`/trpg-compact` 手动触发，`/trpg-recap` 快速回顾。
- **工具收敛**：跑团会话只保留 `trpg_*` + `ask_user_question`；宿主无法从该层摘除的 per-agent 工具由 guard 拒绝调用。

## 安装

需要已安装 DSH desktop（本插件按 DSH 插件包格式编写，包含 Host 半区与 Web Client 半区）。

1. 把本仓库的 `plugin/dsh-trpg-mode/` 放到任意目录（例如 `D:\自制跑团\plugin\dsh-trpg-mode`）。
2. 在 DSH 里让 Agent 执行插件安装（或等价操作）：
   ```
   plugin_manager action=install_bundle target=<上一步的绝对路径>
   ```
3. **完全关闭并重开 DSH**（插件含客户端半区，普通 API 安装后需要重启才能加载；宿主不会热更新已加载模块）。
4. 新建会话时，预设选「跑团模式」。

不需要修改 profile 的 `cordis.patch.yml`；插件通过包内 `cordis.patch.yml` 声明自己的插件行与两个预设（`trpg` / `trpg-a`）。卸载方式：`plugin_manager action=remove_bundle target=@local/dsh-trpg-mode` 后重启。

## 使用

1. 新建「跑团模式」会话，说出世界观要求，例如：
   > 我想要蒸汽朋克 + 低魔 + 侦探悬疑，主角是贵族侦探，规则用 d20 简化判定。
2. 主持人会先 `trpg_world op=create` 写入世界观，再 `trpg_sheet op=create` 建角色，然后开始第一幕。
3. 面板右上角可切换查看的团；右侧「存档」页签可管理所有团与存档（按钮会把指令填进输入框，回车执行）。
4. 常用对话指令：
   - 「列出所有团」「切换到团『灰钟港』」「另起一个新团：海雾镇」
   - 「把力量判定改成 2d6，权重 [2,3,4,5,6,5]」「默认骰改成 d100」
   - 「一回合算 15 分钟」「把时间推进到黄昏」
   - 「存档」「列出存档」「删除存档『…』」「读最近一次存档」
   - `/trpg-compact` 压缩上下文，`/trpg-recap` 回顾当前团进度

## 目录结构

```
plugin/dsh-trpg-mode/
├── package.json        # 插件包与 Bundle 声明（dsh.bundle.patch、dsh.client）
├── cordis.patch.yml    # 插件行 + 预设 trpg / trpg-a
├── index.js            # 会话投影（key=trpg）注册、工具工厂导出
├── session.js          # 会话级：工具注册、guard/restrict、/trpg-compact、/trpg-recap
├── compaction.js       # B 档：跑团专用摘要引擎（继承宿主 BasicCompactionEngine）
├── client.js           # Web 客户端：右侧栏面板 + 头部「跑团」按钮
├── lib/state.js        # 状态模型、归一化、骰子/时钟纯函数
├── lib/saves.js        # 团文件、会话映射、存档、旧数据迁移、面板索引
├── lib/tools.js        # 11 个 trpg_* 工具定义
├── locale/*.json       # 面板文案
└── icon.svg
docs/
├── 跑团模式-设计方案.md   # 方案 v1.1（需求、架构、token 估算）
├── 跑团模式-使用说明.md   # 面向使用者的操作手册
└── 验收报告.md           # 实现与验收证据（真实会话结果）
tests/                  # 离线自测脚本（纯函数 / 工具链 / 迁移 / 投影）
```

## 实现要点

- **状态真相**：每次工具结果通过 `output.presentationMeta` 带出完整状态，落进 session 事件 `tool/result.meta.trpg`；会话投影 `key='trpg'` 折叠该事件，客户端用标准 prop `useProjection('trpg')` 读取。
- **面板入口**：客户端注册 `sidebar.right.pane.tab`（key `@local/dsh-trpg-mode/sheet`）作为右侧栏页签，并在 `conversation.session.header.utilities` 放一个「跑团」按钮唤出。
- **压缩 B 档**：从宿主 asar 动态 import `@deepseek-ai/dsh-compaction-basic` 并子类化，只覆盖 `summarize()` 的提示词与附加状态，其余交给宿主；导入失败时降级，不影响插件其余功能。
- **兼容性**：不修改任何已有插件/profile 配置；所有 id 使用 `@local/dsh-trpg-mode` 前缀与独立预设 id。

## 已知限制

- 面板按钮只能把指令填进输入框（宿主未暴露 submit），需要按回车执行。
- 存档页签只做列表与指令填充，删除/读取最终由主持人的工具调用完成。
- 会话内的实时面板只属于「当前会话绑定的团」；查看别团是只读概览。
- 跑团摘要依赖宿主 `llm` 服务；模型需支持长上下文。

## 测试

```bash
node tests/selftest.mjs   # 纯函数
node tests/libtest.mjs    # 团索引
node tests/projtest.mjs   # 投影 init/apply
node tests/fixcheck.mjs   # 旧数据迁移 + 团列表回归
node tests/tooltest.mjs   # 11 工具离线全链路
```

（`tests/tooltest.mjs` 等脚本会在临时目录建数据，不依赖真实 DSH；离线运行时 `defineTool` 不可用属预期，工具体仍可执行。）
