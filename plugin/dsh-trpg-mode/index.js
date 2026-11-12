/**
 * 跑团模式 Host 半边（profile 级全局行）：
 *  - 注册 trpg 会话投影（角色/骰点/团史/存档等状态，面板经投影读取）
 *  - 不注册工具：trpg_* 工具由预设会话内的 ./session 行注册，
 *    因此普通会话完全看不到它们（无需 when 门控，也不污染 toolset）。
 * 不注册任何提示段；GM 指令放在预设 persona 中。
 */
import {
  PROJECTION_KEY,
  STATE_VERSION,
  defaultState,
  normalizeState,
} from './lib/state.js';
import { buildLibrarySync } from './lib/saves.js';
import { createToolDefinitions } from './lib/tools.js';

export const inject = ['sessionProjections'];

/** 供会话级 ./session 行读取投影句柄（同一进程内共享本模块实例）。 */
let projectionHandle = null;
export function getProjectionHandle() {
  return projectionHandle;
}

/** 投影定义（导出以便离线测试：init 会从磁盘播种团/存档索引）。 */
export function buildProjectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: { parse: (value) => value },
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => state,
    },
    init: (header) => {
      // 会话刚建立时就从磁盘播种「团/存档索引」：面板在任何工具调用之前
      // 就能列出工作区已有的团，并允许自由切换查看（不挂载任何团的状态）。
      const base = defaultState();
      try {
        const cwd = header?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) {
          base.library = buildLibrarySync(cwd, base);
        }
      } catch {
        // 磁盘不可读时退回空索引；首次工具调用会再重建
      }
      return base;
    },
    apply(state, event) {
      if (event?.type !== 'tool/result') return state;
      const meta = event.data?.meta ?? event.meta;
      if (!meta || typeof meta !== 'object') return state;
      const next = meta[PROJECTION_KEY];
      if (!next || typeof next !== 'object') return state;
      return normalizeState(next);
    },
  };
}

export async function apply(ctx) {
  // ── 投影：唯一状态来源，tool/result.meta.trpg 携带变更后的完整状态 ──────────
  const definition = buildProjectionDefinition();

  const handle = await ctx.sessionProjections.register(definition);
  projectionHandle = handle;
  ctx.effect(() => () => {
    try {
      handle.dispose();
    } catch {
      // 已释放
    }
    if (projectionHandle === handle) projectionHandle = null;
  });
}

/** 会话行使用：基于投影句柄 + 文件回退构造工具定义。 */
export function buildSessionTools(ctx) {
  return createToolDefinitions(ctx, {
    stateOf(session) {
      const handle = projectionHandle;
      if (!handle || typeof handle.stateOf !== 'function') return undefined;
      try {
        return handle.stateOf(session);
      } catch {
        return undefined;
      }
    },
  });
}
