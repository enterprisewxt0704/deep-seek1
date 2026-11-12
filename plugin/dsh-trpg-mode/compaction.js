/**
 * 跑团专用压缩后端（B 档）：子类化宿主自带的 BasicCompactionEngine，
 * 只替换 summarize() —— 用跑团主持人风格的摘要指令，并把 `.trpg/state.json`
 * 里的面板状态（角色/场景/最近团史）一起交给摘要模型，保证压缩后不丢前情。
 *
 * 依赖从当前 Harness 的 app.asar 动态导入（与宿主共享同一 ESM 模块实例，
 * Service 身份一致）；导入失败时降级为空插件，不影响预设其余部分。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeState } from './lib/state.js';

export const name = 'dsh-trpg-compaction';
export const inject = ['llm'];

const ASAR = `${process.resourcesPath ?? ''}${path.sep}app.asar${path.sep}dsh${path.sep}node_modules${path.sep}`;
const asarUrl = (sub) => pathToFileURL(path.join(ASAR, sub)).href;

let impl = null;
try {
  const [basic, llm, util] = await Promise.all([
    import(asarUrl('@deepseek-ai/dsh-compaction-basic/lib/index.js')),
    import(asarUrl('@deepseek-ai/dsh-llm/lib/index.js')),
    import(asarUrl('@deepseek-ai/dsh-util-values/lib/index.js')),
  ]);
  const Base = basic.BasicCompactionEngine ?? basic.default;
  if (typeof Base !== 'function') throw new Error('BasicCompactionEngine 导出形态不符');
  impl = { Base, llm, util };
} catch (error) {
  console.warn('[dsh-trpg-mode] 跑团压缩后端加载失败，将以无压缩服务降级：', error?.message ?? error);
}

export const TRPG_COMPACTION_INSTRUCTION = `你正在压缩一场桌面角色扮演游戏（TRPG）的会话历史，以便游戏继续。请只输出摘要 Markdown，不要输出任何解释或代码。

摘要必须包含以下小节，无法确定时写「未知」，不要编造：
## 团名与系统
## 世界与当前局势
## 玩家角色
（姓名、职业、等级、HP/MP、关键属性、物品、状态）
## 当前场景
（地点、在场 NPC、目标、游戏内时间）
## 已发生的关键事件
（按时间顺序，只保留会影响后续剧情或判定的内容）
## 悬而未决的线索与伏笔
## 重要 NPC 与人际关系
## 最近判定与骰点
（列出最近 3–5 次检定的名称、点数与结果）
## 未完成的任务
## 下一步可能发生的事

规则：
- 保留具体数字（HP 数值、骰点结果、时间、物品数量），不要写成「一些」「若干」。
- 已写入面板状态（角色卡/场景/团史）的事实优先采用，摘要与面板不得矛盾。
- 压缩后主持人会调用 trpg_recall 取回面板状态，因此你只需保留会话叙事与判定过程，不必重复整张角色卡。`;

async function readStateText(agent) {
  try {
    const cwd = agent?.session?.header?.cwd;
    if (!cwd) return '';
    const raw = JSON.parse(await fs.readFile(path.join(cwd, '.trpg', 'state.json'), 'utf8'));
    const state = normalizeState(raw?.state ?? raw);
    const parts = [
      `团名：${state.campaign.name || '未命名'}｜游戏内时间：${state.clock.label}`,
      `角色：${state.pc.name || '未创建'} Lv.${state.pc.level} HP ${state.pc.hp.cur}/${state.pc.hp.max}`,
      `世界：${state.world.name || '未创建'}｜${state.world.summary || ''}`,
      `场景：${state.scene.title || '未设置'} @ ${state.scene.location || '未知'}`,
    ];
    if (state.digests.length) {
      parts.push('最近团史：');
      for (const digest of state.digests.slice(-3)) parts.push(`- ${digest.title ? `[${digest.title}] ` : ''}${digest.text}`);
    }
    return parts.filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

function makeEngine() {
  if (!impl) {
    return class TrpgCompactionUnavailable {
      constructor() {
        console.warn('[dsh-trpg-mode] 无可用压缩后端，/trpg-compact 与自动压缩不可用');
      }
    };
  }
  const { Base, llm, util } = impl;
  return class TrpgCompactionEngine extends Base {
    async summarize(input, agent, signal) {
      const config = this.config;
      const latest = agent.session.requestHeader()?.config;
      const configured =
        config.summarizationProvider && config.summarizationProvider.length > 0
          ? { provider: config.summarizationProvider, model: config.summarizationModel }
          : undefined;
      const agentTarget =
        agent.options?.provider && agent.options?.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : undefined;
      const target = configured ?? latest ?? agentTarget;
      if (!target) {
        throw new Error('跑团压缩：没有可用的 provider/model（可在压缩配置里设置 summarizationProvider/Model）');
      }

      const panelState = await readStateText(agent);
      const instruction = panelState
        ? `${TRPG_COMPACTION_INSTRUCTION}\n\n【面板当前状态（权威，来自存档）】\n${panelState}`
        : TRPG_COMPACTION_INSTRUCTION;

      const assembler = new llm.BlockAssembler();
      const messages = [
        ...input.messages,
        util.deepFreeze({ role: 'user', content: [{ type: 'text', text: instruction }] }),
      ];
      const options = {
        provider: target.provider,
        model: target.model,
        messages,
        toolHistory: agent.session.toolHistory(),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        maxTokens: config.maxTokens,
        sessionId: agent.session.id,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal }),
      };

      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);

      const finish = assembler.finish;
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        throw new llm.LlmError(finish.failure.message, finish.failure.code, finish.failure);
      }
      if (finish?.kind === 'max-tokens') {
        const error = new Error('跑团摘要被 token 上限截断（压缩未完成）');
        error.code = 'MAX_TOKENS';
        throw error;
      }

      const rawOutput = assembler.blocks();
      if (typeof llm.contentHasImage === 'function' && llm.contentHasImage(rawOutput)) {
        throw new llm.LlmError('跑团摘要不能包含图片输出', 'UNSUPPORTED_CONTENT');
      }
      const summary = rawOutput.filter((block) => block.type === 'text');
      if (!summary.some((block) => String(block.text || '').trim().length > 0)) {
        throw new Error('跑团摘要没有产出任何文本内容');
      }
      return {
        summary,
        rawOutput,
        llmStreamCall: true,
        provider: options.provider,
        model: options.model,
        maxTokens: config.maxTokens,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      };
    }
  };
}

export default makeEngine();
