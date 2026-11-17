/**
 * 跑团模式会话级插件（预设内行）：只在该预设的会话上下文里运行。
 *  - 在会话上下文内注册 trpg_* 工具：普通会话看不到，无需 when 门控
 *  - 注册 /trpg-compact（跑团专用压缩后端）与 /trpg-recap（快速召回状态）
 */
import { buildSessionTools, getProjectionHandle } from './index.js';
import { readCampaign, readSessionBinding } from './lib/saves.js';

export const name = 'dsh-trpg-session';
export const inject = ['commands', 'compaction', 'tools', 'sessions'];

const TRPG_TOOLS = [
  'trpg_world',
  'trpg_sheet',
  'trpg_scene',
  'trpg_roll',
  'trpg_dice',
  'trpg_time',
  'trpg_digest',
  'trpg_recall',
  'trpg_save',
  'trpg_load',
  'trpg_campaigns',
  'trpg_setup',
];

/**
 * 跑团会话只应有 trpg_* 与 ask_user_question。其余工具大多是宿主/编码工具
 * （ops_bash、ops_read_files、hindsight_*、/compact 相关等）：它们会诱导 GM
 * 去翻源码、改插件文件，也白白占用每轮 prompt 的 token。
 *  - 先尝试 restrict 把全局工具从 tool schema 里摘掉（减少 token 与误用）
 *  - 无论 restrict 是否成功，guard 都会在调用层拒绝，作为兜底
 */
const ALLOWED_TOOL_NAMES = new Set([...TRPG_TOOLS, 'ask_user_question']);

const restrictedAgents = new WeakSet();

/**
 * 宿主 restrict 的两条硬规则（见 @deepseek-ai/dsh-tools 的 view()/restrict()）：
 *  - 只能在 agent 自己的 ctx 上调用（preset ctx 调会被拒）；
 *  - 只作用于「继承来的」工具，agent 自己那一层注册的工具不受限制；
 *  - allow 名单里出现未注册的名字会整体抛错。
 * 因此用 allow 白名单一次收口：继承来的工具只留 trpg_* 与 ask_user_question。
 * 逐回合重试直到成功一次（工具注册可能晚于 agent/created）。
 */
function restrictAgentTools(ctx, agent) {
  if (!agent || restrictedAgents.has(agent)) return;
  const attempt = (names) => {
    if (names.length === 0) return false;
    try {
      agent.ctx.tools.restrict({ allow: names });
      restrictedAgents.add(agent);
      return true;
    } catch (error) {
      void error;
      return false;
    }
  };
  if (attempt([...ALLOWED_TOOL_NAMES])) return;
  try {
    const known = agent.ctx.tools.view(agent).restrictableNames;
    attempt([...ALLOWED_TOOL_NAMES].filter((name) => known.has(name)));
  } catch (error) {
    void error;
  }
}

function installToolGuard(ctx) {
  try {
    ctx.effect(() =>
      ctx.tools.guard((exec) => {
        const name = typeof exec?.name === 'string' ? exec.name : '';
        if (name === '' || ALLOWED_TOOL_NAMES.has(name)) return undefined;
        return `跑团模式会话不开放工具「${name}」。世界、角色、场景、骰点、时间与存档都由 trpg_* 工具维护；需要向玩家确认时用 ask_user_question。`;
      }),
    );
  } catch (error) {
    console.warn('[dsh-trpg-mode] 注册工具守卫失败：', error?.message ?? error);
  }

  const maybeRestrict = (agent) => {
    try {
      const session = ctx.get('sessions')?.get?.(agent?.id);
      const preset = session?.header?.agentPreset;
      if (preset !== 'trpg' && preset !== 'trpg-a') return;
      restrictAgentTools(ctx, agent);
    } catch (error) {
      void error;
    }
  };

  try {
    // agent/created 在首个回合之前触发：此时就能把无关的全局工具摘掉，
    // 让模型从第一次请求起只看到 trpg_* 与 ask_user_question。
    ctx.on('agent/created', ({ agent }) => {
      maybeRestrict(agent);
    });
    // 兜底：某些路径（例如恢复的旧 agent）不走 created，就在每回合开始前补一次。
    ctx.on('agent/pre-step', ({ agent }, next) => {
      maybeRestrict(agent);
      return next();
    });
  } catch (error) {
    console.warn('[dsh-trpg-mode] 注册工具收敛钩子失败：', error?.message ?? error);
  }
}

const COMPACTION_ERRORS = {
  busy: '压缩暂时不可用：当前进程正在压缩，或本回合尚未结束（空闲时再试）。',
  cancelled: '压缩已取消。',
  changed: '待压缩的历史在压缩前发生了变化，本次尝试已记录在会话日志里。',
  summary: '没有生成可用的摘要，本次尝试已记录在会话日志里。',
  commit: '压缩没有干净完成，部分历史可能已改变；请检查会话状态后重试。',
  persistence: '压缩完成，但会话保存失败。',
};

async function executeCompact(ctx, invocation) {
  if (String(invocation.rawInput || '').trim().length > 0) {
    return { kind: 'error', text: '用法：/trpg-compact（不接受参数）' };
  }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
    if (result === null) return { kind: 'success', text: '还没有可压缩的历史。' };
    return {
      kind: 'success',
      text: `已压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens）；摘要已按跑团格式重写。继续游戏前建议调用 trpg_recall 核对角色与场景。`,
      sourceEventSeq: result.summarySeq,
    };
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: '压缩已取消。' };
    const code = error?.code;
    if (code && COMPACTION_ERRORS[code]) return { kind: 'error', text: COMPACTION_ERRORS[code] };
    return { kind: 'error', text: `压缩失败：${error?.message ?? String(error)}` };
  }
}

/** 读取当前会话的跑团状态：投影优先，其次会话→团映射文件（不再读旧 state.json）。 */
async function currentState(ctx, invocation) {
  const session = ctx.get('sessions')?.get?.(invocation.agent.id);
  if (!session) return null;
  try {
    const state = getProjectionHandle()?.stateOf?.(session);
    if (state && (state.campaign?.id || state.campaign?.name || state.world?.name || state.pc?.name)) return state;
  } catch {
    // 投影不可读时走文件回退
  }
  const cwd = session.header?.cwd;
  if (!cwd) return null;
  try {
    const campaignId = await readSessionBinding(cwd, session.id);
    if (campaignId) return await readCampaign(cwd, campaignId);
  } catch {
    // 没有映射文件
  }
  return null;
}

async function executeRecap(ctx, invocation) {
  const session = ctx.get('sessions')?.get?.(invocation.agent.id);
  if (!session?.header?.cwd) return { kind: 'error', text: '找不到当前会话的工作目录，无法读取跑团状态。' };
  try {
    const state = await currentState(ctx, invocation);
    if (!state) throw new Error('empty');
    const lines = [
      `【跑团状态】${state?.campaign?.name || '未命名'}${state?.campaign?.id ? `（${state.campaign.id}）` : ''}｜${state?.clock?.label || '时间未知'}`,
      `世界：${state?.world?.name || '未创建'}｜${state?.world?.summary || ''}`,
      `角色：${state?.pc?.name || '未创建'} Lv.${state?.pc?.level ?? 1}｜HP ${state?.pc?.hp?.cur ?? 0}/${state?.pc?.hp?.max ?? 0}`,
      `场景：${state?.scene?.title || '未设置'} @ ${state?.scene?.location || '未知'}`,
    ];
    const digests = Array.isArray(state?.digests) ? state.digests.slice(-2) : [];
    if (digests.length) {
      lines.push('最近团史：');
      for (const d of digests) lines.push(`- ${d.title ? `[${d.title}] ` : ''}${d.text}`);
    }
    return { kind: 'success', text: lines.filter(Boolean).join('\n') };
  } catch {
    return { kind: 'error', text: '还没有跑团状态：先让主持人创建世界观与角色，或读取存档。' };
  }
}

export function apply(ctx) {
  // 先把非跑团工具挡在会话外（restrict 隐藏 + guard 兜底拒绝）。
  try {
    installToolGuard(ctx);
  } catch (error) {
    console.warn('[dsh-trpg-mode] 工具收敛初始化失败：', error?.message ?? error);
  }

  // 会话级工具：注册在本会话上下文，普通（非跑团）会话看不到。
  try {
    for (const definition of buildSessionTools(ctx)) {
      ctx.effect(() => ctx.tools.register(definition));
    }
  } catch (error) {
    console.warn('[dsh-trpg-mode] 注册跑团工具失败：', error?.message ?? error);
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: 'trpg-compact',
      description: '压缩会话历史，使用跑团专用摘要格式（保留角色/场景/判定与伏笔）',
      handler: (invocation) => executeCompact(ctx, invocation),
    }),
  );
  ctx.effect(() =>
    ctx.commands.register({
      name: 'trpg-recap',
      description: '快速输出当前跑团状态摘要（团名/世界/角色/场景/最近团史）',
      handler: (invocation) => executeRecap(ctx, invocation),
    }),
  );
}

