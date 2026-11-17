/**
 * 跑团模式的全部模型工具（Host 半边）。
 * 每个会改变状态的工具都会把「变更后的完整状态」放进结果 meta.trpg，
 * 由投影折叠成面板可见状态；同时写一份 `.trpg/state.json` 自动检查点。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROJECTION_KEY,
  defaultDiceProfiles,
  defaultState,
  formatClock,
  newId,
  normalizeState,
  resolveOutcome,
  rollOne,
  rollSummaryText,
} from './state.js';
import {
  buildLibrary,
  deleteSave,
  freshCampaign,
  listSaves,
  makeCampaignId,
  migrateLegacyState,
  readCampaign,
  readSave,
  readSessionBinding,
  writeCheckpoint,
  writeSave,
  writeSessionBinding,
} from './saves.js';
import {
  POINT_BUY_TEMPLATES,
  SETUP_GROUPS,
  STAGE_LABELS,
  allQuestions,
  answeredCount,
  defaultSetup,
  describePlacement,
  fillDefaults,
  locationBudget,
  missingQuestions,
  nextHint,
  normalizePool,
  normalizeSetup,
  questionsForGroup,
  resolveTemplate,
  rollAttributeSet,
  rollPlacement,
  validateCards,
  validatePlacement,
  validatePointBuy,
} from './setup.js';

const ASAR_BASE = `${process.resourcesPath}${path.sep}app.asar${path.sep}dsh${path.sep}node_modules${path.sep}`;

let defineTool = (options) => options;
try {
  const mod = await import(pathToFileURL(path.join(ASAR_BASE, '@deepseek-ai/dsh-tools/lib/index.js')).href);
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch (error) {
  console.warn('[dsh-trpg-mode] defineTool 不可用，工具 schema 将不做方言编译：', error?.message ?? error);
}

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

/** JSON Schema → dsh-tools value-schema DSL（required 内联，object 必须显式 additionalProperties）。 */
function convertValue(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  let src = node;
  if (src.type === undefined && src.properties && typeof src.properties === 'object') {
    src = { ...src, type: 'object', additionalProperties: src.additionalProperties ?? true };
  }
  const out = {};
  for (const key of ANNOTATIONS) if (src[key] !== undefined) out[key] = src[key];
  if (src.enum !== undefined) out.enum = [...src.enum];
  if (src.type !== undefined) out.type = src.type;
  if (src.oneOf) out.oneOf = src.oneOf.map(convertValue);
  if (src.type === 'object') {
    out.additionalProperties = src.additionalProperties === undefined ? true : !!src.additionalProperties;
    if (src.properties && typeof src.properties === 'object') {
      const required = Array.isArray(src.required) ? src.required : [];
      out.properties = {};
      for (const [key, value] of Object.entries(src.properties)) {
        out.properties[key] = {
          ...convertValue(value),
          ...(required.includes(key) ? { required: true } : {}),
        };
      }
    }
  } else if (src.type === 'array') {
    out.items = src.items === undefined ? { type: 'json' } : convertValue(src.items);
  }
  return out;
}

/** 工具参数对象（JSON Schema）→ ParameterSchemaSpec。 */
function toParameterSpec(schema) {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const spec = {};
  for (const [key, value] of Object.entries(props)) {
    spec[key] = { ...convertValue(value), ...(required.includes(key) ? { required: true } : {}) };
  }
  return spec;
}

/** 工具返回值：只返回 value；content 由 render 生成，meta 由 presentationMeta 生成。 */
const textResult = (text, extra = {}, meta) => ({
  text,
  ...extra,
  ...(meta && meta[PROJECTION_KEY] !== undefined ? { __trpg: meta[PROJECTION_KEY] } : {}),
});

function makeTool(name, description, parameters, run) {
  return defineTool({
    name,
    description,
    parameters: toParameterSpec(parameters),
    output: {
      // 根节点额外容纳 __trpg（完整状态）等附加字段
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
      render(_args, value) {
        const text =
          value && typeof value === 'object' && typeof value.text === 'string'
            ? value.text
            : typeof value === 'string'
              ? value
              : JSON.stringify(value ?? null);
        return [{ type: 'text', text }];
      },
      presentationMeta(_args, value) {
        const state = value && typeof value === 'object' ? value.__trpg : undefined;
        return { [PROJECTION_KEY]: state === undefined ? null : state };
      },
    },
    async execute(args, exec) {
      return run(args ?? {}, exec);
    },
  });
}

const pcBrief = (pc) => {
  const attrs = Object.entries(pc.attributes || {})
    .map(([k, v]) => `${k} ${v}`)
    .join('，');
  const lines = [
    `角色：${pc.name || '未创建'}${pc.race ? `（${pc.race}）` : ''}${pc.class ? ` ${pc.class}` : ''} Lv.${pc.level}`,
    `生命 ${pc.hp.cur}/${pc.hp.max}｜魔力 ${pc.mp.cur}/${pc.mp.max}｜护甲 ${pc.ac}｜经验 ${pc.xp}`,
    attrs ? `属性：${attrs}` : '',
    pc.conditions?.length ? `状态：${pc.conditions.join('、')}` : '',
    pc.inventory?.length ? `物品：${pc.inventory.join('、')}` : '',
    pc.notes ? `备注：${pc.notes}` : '',
  ];
  return lines.filter(Boolean).join('\n');
};

const worldBrief = (world) =>
  [
    `世界：${world.name || '未创建'}${world.genre ? `（${world.genre}）` : ''}`,
    world.summary ? `概要：${world.summary}` : '',
    world.tone ? `基调：${world.tone}` : '',
    world.rules?.length ? `规则：${world.rules.join('；')}` : '',
    world.factions?.length ? `势力：${world.factions.map(String).join('；')}` : '',
    world.locations?.length ? `地点：${world.locations.map(String).join('；')}` : '',
    world.hooks?.length ? `钩子：${world.hooks.map(String).join('；')}` : '',
    world.notes ? `备注：${world.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const sceneBrief = (scene) =>
  [
    `场景：${scene.title || '未设置'}${scene.location ? ` @ ${scene.location}` : ''}`,
    scene.timeLabel ? `时间：${scene.timeLabel}` : '',
    scene.participants?.length ? `在场：${scene.participants.join('、')}` : '',
    scene.goal ? `目标：${scene.goal}` : '',
    scene.notes ? `备注：${scene.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []);

export function createToolDefinitions(ctx, handle) {
  const stateOfSession = (session) => {
    try {
      const state = handle.stateOf(session);
      return state ? normalizeState(state) : null;
    } catch {
      return null;
    }
  };

  const sessionOf = (exec) => {
    const id = exec?.agent?.id;
    return id ? ctx.get('sessions')?.get?.(id) : undefined;
  };

  const cwdOf = (session) => session?.header?.cwd || process.cwd();
  const sessionIdOf = (exec) => exec?.agent?.id;

  /** 旧版全局 state.json 只在第一次用到时迁移成独立团，不挂到任何新会话。 */
  const legacyMigrated = new Set();
  const ensureLegacyMigrated = async (cwd) => {
    if (legacyMigrated.has(cwd)) return;
    legacyMigrated.add(cwd);
    try {
      await migrateLegacyState(cwd);
    } catch {
      // 迁移失败忽略，旧文件仍在
    }
  };

  const withCampaignId = (state, fallbackName = '') => {
    if (!state.campaign.id) {
      const name = state.campaign.name || state.world.name || fallbackName;
      state.campaign.id = makeCampaignId(name);
      if (!state.campaign.startedAt) state.campaign.startedAt = new Date().toISOString();
    }
    return state;
  };

  /** 只读本会话自己的团：投影 → 会话映射的团文件；绝不读取其他团的全局状态。 */
  const getState = async (exec) => {
    const session = sessionOf(exec);
    const cwd = cwdOf(session);
    await ensureLegacyMigrated(cwd);
    let state = stateOfSession(session);
    const meaningful =
      state && (state.campaign.id || state.campaign.name || state.world.name || state.pc.name);
    if (!meaningful) {
      const boundId = await readSessionBinding(cwd, sessionIdOf(exec));
      if (boundId) {
        const own = await readCampaign(cwd, boundId);
        if (own) state = own;
      }
    }
    // 不在这里补 campaign.id：只有 commit 才真正建团，避免读操作凭空生成团 id。
    return normalizeState(state ?? defaultState());
  };

  const commit = async (exec, next, extra = {}) => {
    const session = sessionOf(exec);
    const cwd = cwdOf(session);
    const state = withCampaignId(normalizeState({ ...next, lastUpdated: new Date().toISOString() }));
    await writeCheckpoint(cwd, state);
    await writeSessionBinding(cwd, sessionIdOf(exec), state.campaign.id);
    let library;
    try {
      library = await buildLibrary(cwd, state);
    } catch {
      library = undefined;
    }
    const visible = library ? { ...state, library } : state;
    return textResult(extra.text ?? '已更新跑团状态。', extra.value ?? {}, { [PROJECTION_KEY]: visible });
  };

  const tools = [];

  tools.push(
    makeTool(
      'trpg_world',
      '查看或写入跑团世界观。流程：用户给出世界观要求 → 你据此生成完整世界观 → 用 op=create 写入设定。op=get 读取当前世界观；op=new 为当前会话另起一个全新的团（会清空当前团状态，面板与存档按新团隔离）。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['get', 'create', 'update', 'new'], description: 'get 读取；create 覆盖写入完整世界观（当前团）；update 局部更新；new 另起新团。' },
          requirements: { type: 'string', description: '用户给出的世界观要求（原文或摘要），用于存档留痕。' },
          world: {
            type: 'object',
            description: '世界观对象：name/genre/summary/tone/rules/factions/locations/hooks/notes。',
            properties: {
              name: { type: 'string' },
              genre: { type: 'string' },
              summary: { type: 'string' },
              tone: { type: 'string' },
              rules: { type: 'array', items: { type: 'json' } },
              factions: { type: 'array', items: { type: 'json' } },
              locations: { type: 'array', items: { type: 'json' } },
              hooks: { type: 'array', items: { type: 'json' } },
              notes: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        if (args.op === 'get') {
          return textResult(worldBrief(state.world), { world: state.world });
        }
        let base = state;
        if (args.op === 'new') {
          const wanted = String(args.world?.name || args.world?.genre || '').trim();
          base = freshCampaign(wanted);
        }
        const world = { ...base.world, ...(args.world || {}) };
        for (const key of ['rules', 'factions', 'locations', 'hooks']) {
          if (args.world && key in args.world) world[key] = asList(args.world[key]).slice(0, 200);
        }
        if (args.requirements) world.notes = world.notes || `用户要求：${String(args.requirements).slice(0, 2000)}`;
        if (!base.campaign.name && world.name) base.campaign.name = world.name;
        if (!base.campaign.system && world.genre) base.campaign.system = world.genre;
        const next = { ...base, world };
        const prefix = args.op === 'new' ? `已另起新团「${next.campaign.name || '未命名'}」（与旧团完全隔离）。\n` : '';
        return commit(exec, next, {
          text: `${prefix}已写入世界观：\n${worldBrief(normalizeState(next).world)}`,
          value: { world, campaignId: next.campaign.id },
        });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_sheet',
      '查看或写入玩家角色卡（PC）。op=get 读取；op=create 覆盖创建；op=update 局部更新；op=delta 修改生命/魔力/经验/物品/状态。面板会同步显示。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['get', 'create', 'update', 'delta'] },
          sheet: {
            type: 'object',
            description: '角色卡字段：name/race/class/level/attributes/skills/hp/mp/ac/inventory/conditions/xp/notes。',
            additionalProperties: true,
          },
          delta: {
            type: 'object',
            description: 'op=delta 时的增量：hp（正负整数）、mp、xp、addItems、removeItems、addConditions、removeConditions。',
            properties: {
              hp: { type: 'integer' },
              mp: { type: 'integer' },
              xp: { type: 'integer' },
              addItems: { type: 'array', items: { type: 'string' } },
              removeItems: { type: 'array', items: { type: 'string' } },
              addConditions: { type: 'array', items: { type: 'string' } },
              removeConditions: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        if (args.op === 'get') return textResult(pcBrief(state.pc), { pc: state.pc });

        let pc = state.pc;
        if (args.op === 'create') pc = normalizeState({ ...state, pc: args.sheet || {} }).pc;
        else if (args.op === 'update') pc = normalizeState({ ...state, pc: { ...state.pc, ...(args.sheet || {}) } }).pc;
        else {
          const d = args.delta || {};
          const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
          const nextPc = {
            ...state.pc,
            hp: { ...state.pc.hp, cur: clamp((state.pc.hp?.cur ?? 0) + Number(d.hp || 0), 0, state.pc.hp?.max ?? 1e9) },
            mp: { ...state.pc.mp, cur: clamp((state.pc.mp?.cur ?? 0) + Number(d.mp || 0), 0, state.pc.mp?.max ?? 1e9) },
            xp: (state.pc.xp || 0) + Number(d.xp || 0),
            inventory: [...(state.pc.inventory || []), ...(d.addItems || [])].filter(
              (item) => !(d.removeItems || []).includes(item),
            ),
            conditions: [...(state.pc.conditions || []), ...(d.addConditions || [])].filter(
              (item) => !(d.removeConditions || []).includes(item),
            ),
          };
          pc = nextPc;
        }
        const next = { ...state, pc };
        return commit(exec, next, { text: `角色卡已更新：\n${pcBrief(pc)}`, value: { pc } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_scene',
      '查看或设置当前场景（地点、在场人物、当前目标、时间标签）。每进入新场景时调用 op=set。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['get', 'set'] },
          scene: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              location: { type: 'string' },
              timeLabel: { type: 'string' },
              participants: { type: 'array', items: { type: 'string' } },
              goal: { type: 'string' },
              notes: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        if (args.op === 'get') return textResult(sceneBrief(state.scene), { scene: state.scene });
        const scene = normalizeState({
          ...state,
          scene: { ...state.scene, ...(args.scene || {}), updatedAt: new Date().toISOString() },
        }).scene;
        const next = { ...state, scene };
        return commit(exec, next, { text: `场景已更新：\n${sceneBrief(scene)}`, value: { scene } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_roll',
      '掷骰并记录结果（面板会显示历史骰点）。骰子默认使用面板中当前配置的概率权重；可用 profile 指定骰型。所有判定必须通过本工具完成，不得口算或编造点数。',
      {
        type: 'object',
        properties: {
          label: { type: 'string', description: '检定名称，如「察觉」「手枪射击」。' },
          profile: { type: 'string', description: '骰型 id（如 d20/d100），默认取面板当前默认骰。' },
          sides: { type: 'integer', description: '临时指定面数（覆盖 profile）。' },
          count: { type: 'integer', description: '骰子数量，默认 1。' },
          modifier: { type: 'integer', description: '加值，默认 0。' },
          target: {
            type: 'object',
            description: '判定目标：type=ge 表示总值≥value 成功；type=le 表示总值≤value 成功。',
            properties: {
              type: { type: 'string', enum: ['ge', 'le'] },
              value: { type: 'number' },
            },
            required: ['type', 'value'],
            additionalProperties: false,
          },
          advantage: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: '单骰 d20 的优势/劣势。' },
          note: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        const profiles = state.diceConfig.profiles;
        const profile =
          profiles.find((p) => p.id === args.profile) ||
          profiles.find((p) => p.id === state.diceConfig.defaultId) ||
          profiles[0];
        const sides = Number(args.sides) > 0 ? Number(args.sides) : profile.sides;
        const weights = sides === profile.sides ? profile.weights : null;
        const count = Math.max(1, Math.min(20, Math.round(Number(args.count) || 1)));

        const dice = [];
        for (let i = 0; i < count; i += 1) dice.push(rollOne(sides, weights));
        if (count === 1 && sides === 20 && args.advantage && args.advantage !== 'normal') {
          const second = rollOne(sides, weights);
          dice.push({ ...second, advantage: args.advantage });
          const keep = args.advantage === 'advantage' ? Math.max(dice[0].value, second.value) : Math.min(dice[0].value, second.value);
          const chosen = dice.find((d, idx) => idx < 2 && d.value === keep) || dice[0];
          dice.splice(0, 2, { ...chosen, kept: true });
        }

        const modifier = Math.round(Number(args.modifier) || 0);
        const total = dice.reduce((sum, d) => sum + d.value, 0) + modifier;
        const target = args.target && Number.isFinite(Number(args.target.value))
          ? { type: args.target.type === 'le' ? 'le' : 'ge', value: Number(args.target.value) }
          : null;
        const outcome = resolveOutcome(dice, total, target);
        const roll = {
          id: newId('roll'),
          at: new Date().toISOString(),
          label: args.label || '',
          dice,
          modifier,
          total,
          target,
          outcome,
          note: args.note || '',
        };
        const next = { ...state, rolls: [...state.rolls, roll].slice(-100) };
        return commit(exec, next, {
          text: `${rollSummaryText(roll)}\n（已记录到骰点历史，当前共 ${next.rolls.length} 条）`,
          value: { roll, rolls: next.rolls },
        });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_dice',
      '管理骰子概率配置：查看骰型、设置各面权重（例如让 d20 的 20 更容易出现）、新增骰型、切换默认骰。设置后面板会同步显示。',
      {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['list', 'set_weights', 'add', 'remove', 'set_default', 'reset'],
          },
          profile: { type: 'string', description: '目标骰型 id。' },
          weights: {
            type: 'array',
            items: { type: 'number' },
            description: '各面权重，长度必须等于该骰型面数；null 或省略表示恢复均匀分布。',
          },
          name: { type: 'string', description: 'op=add 时的显示名。' },
          id: { type: 'string', description: 'op=add 时的骰型 id。' },
          sides: { type: 'integer', description: 'op=add 时的面数。' },
          defaultId: { type: 'string', description: 'op=set_default 时的默认骰型 id。' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        let profiles = [...state.diceConfig.profiles];
        let defaultId = state.diceConfig.defaultId;

        if (args.op === 'set_weights') {
          const idx = profiles.findIndex((p) => p.id === args.profile);
          if (idx < 0) throw new Error(`未知骰型：${args.profile}`);
          const weights = Array.isArray(args.weights) ? args.weights : null;
          if (weights && weights.length !== profiles[idx].sides) {
            throw new Error(`权重长度必须等于面数 ${profiles[idx].sides}，收到 ${weights.length}`);
          }
          profiles[idx] = { ...profiles[idx], weights: weights ? weights.map((w) => Math.max(0, Number(w) || 0)) : null };
        } else if (args.op === 'add') {
          const sides = Math.max(2, Math.min(1000, Math.round(Number(args.sides) || 20)));
          const id = (args.id || `d${sides}`).replace(/[^a-zA-Z0-9_-]/g, '');
          if (profiles.some((p) => p.id === id)) throw new Error(`骰型 id 已存在：${id}`);
          const weights =
            Array.isArray(args.weights) && args.weights.length === sides
              ? args.weights.map((w) => Math.max(0, Number(w) || 0))
              : null;
          profiles.push({ id, name: args.name || id.toUpperCase(), sides, weights, explode: false });
        } else if (args.op === 'remove') {
          profiles = profiles.filter((p) => p.id !== args.profile);
          if (profiles.length === 0) profiles = defaultDiceProfiles();
          if (!profiles.some((p) => p.id === defaultId)) defaultId = profiles[0].id;
        } else if (args.op === 'set_default') {
          if (!profiles.some((p) => p.id === args.defaultId)) throw new Error(`未知骰型：${args.defaultId}`);
          defaultId = args.defaultId;
        } else if (args.op === 'reset') {
          profiles = defaultDiceProfiles();
          defaultId = 'd20';
        }

        const next = { ...state, diceConfig: { defaultId, profiles } };
        const lines = profiles.map((p) => {
          const weighted = p.weights ? '（自定义权重）' : '（均匀）';
          return `- ${p.id}：${p.name} 1d${p.sides} ${weighted}${p.id === defaultId ? ' ← 默认' : ''}`;
        });
        return commit(exec, next, { text: `骰子配置：\n${lines.join('\n')}`, value: { diceConfig: next.diceConfig } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_time',
      '管理游戏内时间：查看/设置时钟、推进时间、配置单回合时间跨度（estimate 模式按每回合固定分钟数推进，fixed 模式需显式给定分钟）。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['get', 'advance', 'set', 'config'] },
          minutes: { type: 'integer', description: '推进的分钟数（advance）。' },
          turns: { type: 'integer', description: '推进的回合数（advance，estimate 模式按 minutesPerTurn 折算）。' },
          elapsedMinutes: { type: 'integer', description: '直接设置已流逝分钟数（set）。' },
          label: { type: 'string', description: '自定义时间标签（set，可选）。' },
          mode: { type: 'string', enum: ['estimate', 'fixed'], description: '时间模式（config）。' },
          minutesPerTurn: { type: 'integer', description: '单回合分钟数（config，estimate 模式）。' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        const timeConfig = { ...state.timeConfig };
        let clock = { ...state.clock };

        if (args.op === 'config') {
          if (args.mode) timeConfig.mode = args.mode === 'fixed' ? 'fixed' : 'estimate';
          if (Number(args.minutesPerTurn) > 0) timeConfig.minutesPerTurn = Math.round(Number(args.minutesPerTurn));
        } else if (args.op === 'advance') {
          let minutes = Number(args.minutes) || 0;
          if (!minutes && Number(args.turns) > 0) minutes = Number(args.turns) * timeConfig.minutesPerTurn;
          if (!minutes) minutes = timeConfig.minutesPerTurn;
          clock.elapsedMinutes = Math.max(0, clock.elapsedMinutes + Math.round(minutes));
        } else if (args.op === 'set') {
          if (Number.isFinite(Number(args.elapsedMinutes))) clock.elapsedMinutes = Math.max(0, Math.round(Number(args.elapsedMinutes)));
        }
        clock.label = formatClock(clock.elapsedMinutes);
        if (args.label) clock.label = String(args.label);
        const next = { ...state, timeConfig, clock };
        return commit(exec, next, {
          text: `游戏时间：${clock.label}（已流逝 ${clock.elapsedMinutes} 分钟）｜模式 ${timeConfig.mode}｜单回合 ${timeConfig.minutesPerTurn} 分钟`,
          value: { clock, timeConfig },
        });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_digest',
      '追加一条团史摘要（重要剧情、决定、伏笔、人物关系的压缩记录）。长会话中每 10 回合或每幕结束时调用一次，op=list 可查看全部摘要。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'list'] },
          title: { type: 'string', description: '摘要标题。' },
          text: { type: 'string', description: '摘要正文（200–600 字，只保留会影响后续剧情的信息）。' },
          covers: { type: 'string', description: '覆盖范围，如「第 3 幕」「回合 12–20」。' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        if (args.op === 'list') {
          const text = state.digests.length
            ? state.digests.map((d, i) => `${i + 1}. [${d.title || '摘要'}] ${d.text}`).join('\n\n')
            : '暂无团史摘要。';
          return textResult(text, { digests: state.digests });
        }
        if (!String(args.text || '').trim()) throw new Error('摘要正文不能为空');
        const digest = {
          id: newId('digest'),
          at: new Date().toISOString(),
          title: String(args.title || '').slice(0, 80),
          text: String(args.text).slice(0, 4000),
          covers: String(args.covers || '').slice(0, 80),
        };
        const next = { ...state, digests: [...state.digests, digest].slice(-30) };
        return commit(exec, next, { text: `已追加团史摘要（共 ${next.digests.length} 条）。`, value: { digest } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_recall',
      '召回当前跑团状态摘要：世界观、角色、场景、最近团史与最近骰点。会话被压缩后、或不确定当前剧情进度时先调用本工具，不要凭空编造前情。',
      {
        type: 'object',
        properties: {
          recentRolls: { type: 'integer', description: '返回最近几条骰点，默认 5。' },
          digestCount: { type: 'integer', description: '返回最近几条团史摘要，默认 3。' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        const rollCount = Math.max(0, Math.min(20, Math.round(Number(args.recentRolls) || 5)));
        const digestCount = Math.max(0, Math.min(10, Math.round(Number(args.digestCount) || 3)));
        const parts = [
          `【跑团状态召回】`,
          `团名：${state.campaign.name || '未命名'}${state.campaign.system ? `｜系统：${state.campaign.system}` : ''}｜时间：${state.clock.label}`,
          worldBrief(state.world),
          pcBrief(state.pc),
          sceneBrief(state.scene),
        ];
        if (state.setup && state.setup.stage !== 'ready') {
          parts.push(`开局流程：${STAGE_LABELS[state.setup.stage] || state.setup.stage}｜${nextHint(state.setup)}`);
        }
        if (state.digests.length) {
          parts.push('最近团史：');
          for (const d of state.digests.slice(-digestCount)) parts.push(`- ${d.title ? `[${d.title}] ` : ''}${d.text}`);
        }
        if (rollCount && state.rolls.length) {
          parts.push('最近骰点：');
          for (const r of state.rolls.slice(-rollCount)) parts.push(`- ${rollSummaryText(r)}`);
        }
        const text = parts.filter(Boolean).join('\n');
        return textResult(text, { state });
      },
    ),
  );

  const savesText = (saves) =>
    saves.length
      ? saves
          .map(
            (s, i) =>
              `${i + 1}. ${s.campaign ? `【${s.campaign}】` : ''}${s.name}｜槽位 ${s.slot}｜${s.createdAt}${s.note ? `｜${s.note}` : ''}`,
          )
          .join('\n')
      : '暂无存档。';

  tools.push(
    makeTool(
      'trpg_save',
      '存档：op=save 把当前团的完整状态写入 .trpg/saves/（文件名带团 id，不会串到别的团）；op=list 列出所有存档（含所属团）；op=delete 删除指定存档（file / name / slot，或整团 campaignId）。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['save', 'list', 'delete'], description: 'save 存档；list 列出存档；delete 删除存档。' },
          slot: { type: 'string', description: '存档槽位名：op=save 用它命名存档，op=delete 用它定位存档。' },
          note: { type: 'string', description: '存档备注。' },
          file: { type: 'string', description: 'op=delete 时要删除的存档文件名。' },
          name: { type: 'string', description: 'op=delete 时的存档名（与 file 二选一）。' },
          campaignId: { type: 'string', description: 'op=delete 时按团删除该团的全部存档。' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const session = sessionOf(exec);
        const cwd = cwdOf(session);
        if (args.op === 'list') {
          const saves = await listSaves(cwd);
          return textResult(savesText(saves), { saves });
        }
        if (args.op === 'delete') {
          const removed = await deleteSave(cwd, { file: args.file, name: args.name, slot: args.slot, campaignId: args.campaignId });
          const state = await getState(exec);
          const text = `已删除存档：${removed.removed.join('、')}`;
          return commit(exec, state, { text, value: removed });
        }
        const state = await getState(exec);
        const result = await writeSave(cwd, state, { slot: args.slot, note: args.note });
        return commit(exec, state, {
          text: `已存档：${result.file}\n团「${state.campaign.name || '未命名'}」｜槽位 ${result.slot}${result.note ? `｜备注：${result.note}` : ''}`,
          value: result,
        });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_load',
      '读档：op=list 列出所有存档（含所属团）；op=load 读取存档覆盖当前团状态。可用 file 指定存档、campaignId 读取该团最近存档、slot 指定槽位；都不传时优先读取**当前团**最近一次存档（读不到才回退到全局最近存档）。读取别的团的存档会把当前会话切到那个团（各团状态与存档独立）。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['load', 'list'], description: 'list 只列出存档；默认 load 读取存档。' },
          slot: { type: 'string', description: '槽位名。' },
          file: { type: 'string', description: '存档文件名或绝对路径（必须在 .trpg/saves 内）。' },
          campaignId: { type: 'string', description: '读取该团最近一次存档（会切换到该团）。' },
          latest: { type: 'boolean', description: '读取最近一次存档。' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const session = sessionOf(exec);
        const cwd = cwdOf(session);
        if (args.op === 'list') {
          const saves = await listSaves(cwd);
          return textResult(savesText(saves), { saves });
        }
        let loadArgs = args;
        const hasTarget = Boolean(args.file || args.campaignId || args.slot || args.latest);
        if (!hasTarget) {
          try {
            const current = await getState(exec);
            if (current.campaign.id) loadArgs = { campaignId: current.campaign.id };
          } catch {
            // 读不到当前团时按全局最近存档
          }
        }
        let loaded;
        try {
          loaded = await readSave(cwd, loadArgs);
        } catch (error) {
          if (loadArgs.campaignId) loaded = await readSave(cwd, {});
          else throw error;
        }
        const next = normalizeState(loaded.state);
        const text = [
          `已读档：${loaded.file}`,
          `团「${next.campaign.name || '未命名'}」｜槽位 ${loaded.slot || '未知'}｜${loaded.createdAt || ''}${loaded.note ? `｜备注：${loaded.note}` : ''}`,
          '',
          worldBrief(next.world),
          '',
          pcBrief(next.pc),
          '',
          sceneBrief(next.scene),
        ].join('\n');
        return commit(exec, next, { text, value: { file: loaded.file, slot: loaded.slot, campaignId: loaded.campaignId } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_campaigns',
      '团管理：op=list 列出工作区里所有团（含角色、场景、更新时间、存档数，标出当前团）；op=open 切换到指定团继续玩（按 id 或名称匹配）；op=new 另起一个全新团（可给 name）。每个团的世界、角色、骰点与存档完全独立，不会串团。',
      {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'open', 'new'] },
          id: { type: 'string', description: 'op=open 时的团 id（可用 op=list 查看）。' },
          name: { type: 'string', description: 'op=open 时的团名（部分匹配）；op=new 时新团名字。' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const session = sessionOf(exec);
        const cwd = cwdOf(session);
        const state = await getState(exec);
        const library = await buildLibrary(cwd, state);
        if (args.op === 'list') {
          const lines = library.campaigns.map((c, i) => {
            const mark = c.id === library.activeCampaignId ? ' ← 当前团' : '';
            const pc = c.pcName ? `｜角色 ${c.pcName}` : '';
            const scene = c.sceneTitle ? `｜场景 ${c.sceneTitle}` : '';
            const saves = c.saveCount ? `｜存档 ${c.saveCount}` : '';
            return `${i + 1}. 【${c.name}】${c.system ? `（${c.system}）` : ''}｜id ${c.id}${pc}${scene}${saves}｜更新 ${c.updatedAt || '未知'}${mark}`;
          });
          const head = library.campaigns.length
            ? `工作区共有 ${library.campaigns.length} 个团：`
            : '还没有任何团（先创建世界观：trpg_world op=create）。';
          return textResult(`${head}\n${lines.join('\n')}`.trimEnd(), { campaigns: library.campaigns });
        }
        if (args.op === 'new') {
          const next = freshCampaign(String(args.name || '').trim());
          return commit(exec, next, {
            text: `已另起新团「${next.campaign.name || '未命名'}」（id ${next.campaign.id}）。旧团数据与存档保持原样，面板只显示这个新团。`,
            value: { campaignId: next.campaign.id },
          });
        }
        const want = String(args.id || args.name || '').trim();
        if (!want) throw new Error('op=open 需要 id 或 name，可先用 op=list 查看有哪些团');
        const found = library.campaigns.find((c) => c.id === want) || library.campaigns.find((c) => c.name === want) || library.campaigns.find((c) => c.name.includes(want));
        if (!found) throw new Error(`找不到团「${want}」，可用 trpg_campaigns op=list 查看`);
        const loaded = await readCampaign(cwd, found.id);
        if (!loaded) throw new Error(`团「${found.name}」的状态文件无法读取`);
        const text = [
          `已切换到团「${loaded.campaign.name || found.name}」`,
          '',
          worldBrief(loaded.world),
          '',
          pcBrief(loaded.pc),
          '',
          sceneBrief(loaded.scene),
        ].join('\n');
        return commit(exec, loaded, { text, value: { campaignId: found.id } });
      },
    ),
  );

  tools.push(
    makeTool(
      'trpg_setup',
      '开局流程管理：20 问世界观问卷 → 生成世界 → 车卡（购点/随机/主持人人物卡）→ 选择开始地点（购点/随机）→ 第一幕。用 questions/record 收集答案，world 写世界观，pc_* 车卡，place_* 选地点；status 查当前阶段。旧团（无 setup）视为已完成开局。',
      {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: [
              'status',
              'questions',
              'record',
              'world',
              'pc_method',
              'pc_pointbuy',
              'pc_roll',
              'pc_cards_set',
              'pc_pick',
              'pc_finalize',
              'place_method',
              'place_pointbuy',
              'place_roll',
              'place_finalize',
              'restart',
              'skip',
            ],
            description: 'status 查阶段；questions 取问卷；record 记录答案；world 写世界；pc_* 车卡；place_* 地点；restart 重开问卷；skip 跳过开局。',
          },
          group: { type: 'string', description: 'questions 时的问卷分组 g1–g5（不传返回下一组未答题）。' },
          answers: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: 'record 的答案：[{id:"q1", answer:"蒸汽朋克"}]。',
          },
          world: { type: 'object', additionalProperties: true, description: 'world 的世界观对象（name/genre/summary/tone/rules/factions/locations/hooks/notes/society/economy/culture/religion/tech/secrets）。' },
          quick: { type: 'boolean', description: 'world 时可传 true：用默认答案补齐未答问卷（快速开局）。' },
          method: { type: 'string', enum: ['self', 'cards', 'pointbuy', 'roll'], description: 'pc_method：self/pointbuy/roll 自建，cards 用主持人人物卡；place_method：pointbuy 或 roll。' },
          template: { type: 'string', enum: ['d20', '2d6', 'percentile', 'narrative'], description: '车卡模板（默认按问卷答案自动选择）。' },
          alloc: { type: 'object', additionalProperties: true, description: 'pc_pointbuy 的属性分配，例如 {"力量":12,...}。' },
          cards: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'pc_cards_set 的 3 张人物卡（name/race/class/attributes/…）。' },
          index: { type: 'integer', description: 'pc_pick 选第几张人物卡（1–3）。' },
          pool: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: '地点候选池：[{id,name,kind}]，kind ∈ region/landmark/faction/mood。',
          },
          picks: { type: 'array', items: { type: 'string' }, description: 'place_pointbuy 选中的候选 id。' },
          title: { type: 'string', description: 'place_finalize 的场景标题（可选）。' },
          name: { type: 'string', description: 'pc_finalize 的角色名。' },
          background: { type: 'string', description: 'pc_finalize 的角色背景。' },
          goal: { type: 'string', description: 'pc_finalize 的角色目标。' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const state = await getState(exec);
        let setup = normalizeSetup(state.setup);

        const commitSetup = (nextSetup, text, value = {}) => {
          const next = { ...state, setup: normalizeSetup(nextSetup) };
          return commit(exec, next, { text, value: { stage: next.setup.stage, ...value } });
        };

        const needWorld = () => {
          if (!state.world.name && !state.campaign.name) {
            throw new Error('还没有世界观：先完成 20 问卷并 op=world 生成世界，或 op=skip 跳过开局。');
          }
        };

        const templateOf = (value, fallback) => (POINT_BUY_TEMPLATES[value] ? value : fallback);

        const diceText = (entry) =>
          entry.rolls
            .map((r) => `${r.id}：${r.dice.join(',')} → ${r.total}${r.rawTotal !== undefined && r.rawTotal !== r.total ? `（2d6=${r.rawTotal}）` : ''}`)
            .join('；');

        const statusText = () => {
          const total = allQuestions().length;
          const answered = answeredCount(setup);
          const missing = missingQuestions(setup).map((q) => q.id);
          const lines = [
            `【开局流程】阶段：${STAGE_LABELS[setup.stage] || setup.stage}（${setup.stage}）`,
            `问卷：已答 ${answered}/${total}${missing.length ? `｜未答：${missing.join('、')}` : ''}`,
          ];
          if (setup.pcMethod) {
            lines.push(`角色来源：${setup.pcMethod === 'cards' ? '主持人人物卡' : setup.pcMethod === 'roll' ? '随机生成' : '购点'}`);
          }
          const lastRoll = setup.pcRolls[setup.pcRolls.length - 1];
          if (lastRoll) {
            lines.push(`最近一次随机属性：${Object.entries(lastRoll.attrs).map(([k, v]) => `${k} ${v}`).join('，')}`);
          }
          if (setup.placeDraft && Array.isArray(setup.placeDraft.selected) && setup.placeDraft.selected.length) {
            lines.push(`地点草稿：${setup.placeDraft.selected.map((x) => x.name).join('、')}`);
          }
          lines.push(`下一步：${nextHint(setup)}`);
          return lines.join('\n');
        };

        const questionsText = (list) =>
          list
            .map(
              (q) =>
                `${q.id}【${q.groupTitle}】${q.question}${q.hint ? `（${q.hint}）` : ''}\n  选项：${q.options.join(' / ')}｜默认：${q.default}`,
            )
            .join('\n\n');

        switch (args.op) {
          case 'status':
            return textResult(statusText(), { setup });
          case 'questions': {
            const group = String(args.group || '').trim();
            if (group) {
              const list = questionsForGroup(group);
              if (!list.length) throw new Error(`没有名为「${group}」的问卷分组，可选 g1–g5。`);
              return textResult(`【${list[0].groupTitle}（${group}）】\n\n${questionsText(list)}`, { questions: list });
            }
            const pending = missingQuestions(setup);
            const list = pending.length ? pending.filter((q) => q.group === pending[0].group) : allQuestions();
            return textResult(list.length ? questionsText(list) : '20 问已全部作答，可以用 op=world 生成世界观。', { questions: list });
          }
          case 'record': {
            const answers = Array.isArray(args.answers) ? args.answers : [];
            if (!answers.length) throw new Error('op=record 需要 answers 数组：[{id:"q1",answer:"…"}]。');
            const bank = new Map(allQuestions().map((q) => [q.id, q]));
            const map = new Map(setup.answers.map((a) => [a.id, a]));
            for (const item of answers) {
              const id = String(item && item.id ? item.id : '').trim();
              const answer = String(item && item.answer !== undefined ? item.answer : '').trim();
              const q = bank.get(id);
              if (!q || !answer) continue;
              map.set(id, { id, question: q.question, answer: answer.slice(0, 500), source: 'custom' });
            }
            setup.answers = [...map.values()];
            setup.groupsDone = SETUP_GROUPS.filter((g) => g.questions.every((q) => map.has(q.id))).map((g) => g.id);
            return commitSetup(
              setup,
              `已记录答案，问卷进度 ${answeredCount(setup)}/${allQuestions().length}。\n${nextHint(setup)}`,
            );
          }
          case 'world': {
            const world = args.world && typeof args.world === 'object' ? args.world : null;
            if (!world || (!world.name && !world.genre)) throw new Error('op=world 需要 world.name 或 world.genre。');
            if (args.quick) setup = fillDefaults(setup);
            const merged = { ...state.world, ...world };
            for (const key of ['rules', 'factions', 'locations', 'hooks']) {
              if (key in world) merged[key] = asList(world[key]).slice(0, 200);
            }
            for (const key of ['name', 'genre', 'summary', 'tone', 'notes', 'society', 'economy', 'culture', 'religion', 'tech', 'secrets']) {
              merged[key] = String(merged[key] || '');
            }
            setup.stage = 'world_ready';
            setup.worldDraft = { name: merged.name, genre: merged.genre, at: new Date().toISOString() };
            const next = {
              ...state,
              world: merged,
              campaign: {
                ...state.campaign,
                name: state.campaign.name || merged.name,
                system: state.campaign.system || merged.genre,
              },
              setup: normalizeSetup(setup),
            };
            return commit(exec, next, {
              text: `世界观已生成并写入：\n${worldBrief(normalizeState(next).world)}\n\n下一步：询问玩家角色来源（自建购点 / 自建随机 / 主持人人物卡）。`,
              value: { stage: 'world_ready', worldName: merged.name },
            });
          }
          case 'pc_method': {
            needWorld();
            const method = String(args.method || 'self');
            const template = templateOf(String(args.template || ''), resolveTemplate(setup));
            if (method === 'cards') {
              setup.pcMethod = 'cards';
              setup.stage = 'pc_pick';
              return commitSetup(setup, '已选择：主持人提供 3 张人物卡。请用 op=pc_cards_set 提交 3 张卡（name/race/class/attributes…），再用 op=pc_pick 让玩家挑选。');
            }
            if (method === 'roll') {
              setup.pcMethod = 'roll';
              setup.pointBuy = { ...setup.pointBuy, template };
              setup.stage = 'pc_build';
              return commitSetup(setup, `已选择：随机生成角色，模板「${POINT_BUY_TEMPLATES[template].name}」。请用 op=pc_roll 掷属性（结果不可重掷）。`);
            }
            setup.pcMethod = 'pointbuy';
            setup.pcMode = 'self';
            setup.pointBuy = { ...setup.pointBuy, template };
            setup.stage = 'pc_build';
            return commitSetup(
              setup,
              `已选择：购点车卡，模板「${POINT_BUY_TEMPLATES[template].name}」。请让玩家分配属性，用 op=pc_pointbuy 反复校验；确认后 op=pc_finalize。`,
            );
          }
          case 'pc_pointbuy': {
            needWorld();
            const template = templateOf(String(args.template || ''), setup.pointBuy.template || 'd20');
            const alloc = args.alloc && typeof args.alloc === 'object' ? args.alloc : {};
            const check = validatePointBuy(template, alloc);
            setup.pcMethod = 'pointbuy';
            setup.pointBuy = { template, alloc, spent: check.spent, remaining: check.remaining };
            setup.stage = 'pc_build';
            const text = [
              `模板：${POINT_BUY_TEMPLATES[template].name}`,
              `已花 ${check.spent} 点｜剩余 ${check.remaining} 点`,
              check.valid ? '分配合法，可以用 op=pc_finalize 定稿。' : `还有问题：\n- ${check.errors.join('\n- ')}`,
            ].join('\n');
            return commitSetup(setup, text, { valid: check.valid });
          }
          case 'pc_roll': {
            needWorld();
            const template = templateOf(String(args.template || ''), setup.pointBuy.template || resolveTemplate(setup));
            const result = rollAttributeSet(template);
            setup.pcMethod = 'roll';
            setup.pointBuy = { ...setup.pointBuy, template };
            setup.pcRolls = [...setup.pcRolls, { template, attrs: result.attrs, rolls: result.rolls, traits: result.traits || null, at: new Date().toISOString() }].slice(-10);
            setup.stage = 'pc_build';
            const parts = [`模板：${POINT_BUY_TEMPLATES[template].name}`, diceText({ rolls: result.rolls })];
            if (result.traits && result.traits.length) parts.push(`随机特质：${result.traits.join('、')}`);
            parts.push('如玩家接受，用 op=pc_finalize 定稿（骰面已记录，不可重掷）。');
            return commitSetup(setup, parts.join('\n'), { attrs: result.attrs });
          }
          case 'pc_cards_set': {
            needWorld();
            const cards = Array.isArray(args.cards) ? args.cards.slice(0, 3) : [];
            const template = templateOf(String(args.template || ''), resolveTemplate(setup));
            const issues = validateCards(cards, template);
            if (issues.length) throw new Error(`人物卡不合规：${issues.join('；')}`);
            setup.pcCards = cards.map((c, i) => ({ id: c.id || `card-${i + 1}`, ...c }));
            setup.pcMethod = 'cards';
            setup.stage = 'pc_pick';
            const lines = cards.map((c, i) => `${i + 1}. ${c.name || '未命名'}${c.race ? `（${c.race}）` : ''}${c.class ? ` ${c.class}` : ''}`);
            return commitSetup(setup, `已收到 3 张人物卡：\n${lines.join('\n')}\n\n请玩家选择一张（op=pc_pick index=1..3）。`);
          }
          case 'pc_pick': {
            needWorld();
            if (!setup.pcCards.length) throw new Error('还没有人物卡：先用 op=pc_cards_set 提交 3 张。');
            const index = Math.max(1, Math.min(setup.pcCards.length, Math.round(Number(args.index) || 1))) - 1;
            const chosen = setup.pcCards[index];
            const pc = {
              ...state.pc,
              name: String(chosen.name || '未命名冒险者'),
              race: String(chosen.race || ''),
              class: String(chosen.class || ''),
              level: Math.max(1, Math.round(Number(chosen.level) || 1)),
              attributes: chosen.attributes && typeof chosen.attributes === 'object' ? chosen.attributes : {},
              skills: chosen.skills && typeof chosen.skills === 'object' ? chosen.skills : {},
              hp: chosen.hp && typeof chosen.hp === 'object' ? chosen.hp : state.pc.hp,
              mp: chosen.mp && typeof chosen.mp === 'object' ? chosen.mp : state.pc.mp,
              ac: Number.isFinite(Number(chosen.ac)) ? Number(chosen.ac) : state.pc.ac,
              inventory: Array.isArray(chosen.inventory) ? chosen.inventory : [],
              background: String(chosen.background || ''),
              goal: String(chosen.goal || ''),
              notes: String(chosen.notes || ''),
            };
            setup.pcMethod = 'cards';
            setup.stage = 'place_method';
            return commit(exec, { ...state, pc, setup: normalizeSetup(setup) }, {
              text: `已选择人物卡「${pc.name}」。\n${pcBrief(pc)}\n\n下一步：询问开始地点方式（购点 / 随机）；购点预算 ${locationBudget()} 点。`,
              value: { pcName: pc.name, stage: 'place_method' },
            });
          }
          case 'pc_finalize': {
            needWorld();
            let pc = { ...state.pc };
            if (setup.pcMethod === 'pointbuy') {
              const check = validatePointBuy(setup.pointBuy.template, setup.pointBuy.alloc);
              if (!check.valid) throw new Error(`购点分配还不合法：${check.errors.join('；')}`);
              pc = { ...pc, attributes: check.attrs, name: String(args.name || pc.name || '未命名冒险者') };
            } else if (setup.pcMethod === 'roll') {
              const last = setup.pcRolls[setup.pcRolls.length - 1];
              if (!last) throw new Error('还没有掷骰结果：先 op=pc_roll。');
              pc = { ...pc, attributes: last.attrs, name: String(args.name || pc.name || '未命名冒险者') };
            } else if (setup.pcMethod === 'cards') {
              if (!pc.name) throw new Error('还没有选择人物卡：先 op=pc_pick index=1..3。');
            } else {
              throw new Error('还没有选择角色来源：先 op=pc_method。');
            }
            if (args.name) pc.name = String(args.name);
            if (args.background) pc.background = String(args.background);
            if (args.goal) pc.goal = String(args.goal);
            setup.stage = 'place_method';
            return commit(exec, { ...state, pc, setup: normalizeSetup(setup) }, {
              text: `角色已定稿：\n${pcBrief(pc)}\n\n下一步：询问开始地点方式（购点 / 随机）；购点预算 ${locationBudget()} 点。`,
              value: { pcName: pc.name, stage: 'place_method' },
            });
          }
          case 'place_method': {
            const method = String(args.method || 'pointbuy');
            if (method !== 'pointbuy' && method !== 'roll') throw new Error('op=place_method 的 method 只能是 pointbuy 或 roll。');
            setup.placeMethod = method;
            setup.stage = 'place_method';
            if (Array.isArray(args.pool)) setup.placeDraft = { method, pool: normalizePool(args.pool) };
            const text =
              method === 'pointbuy'
                ? `已选择地点购点：预算 ${locationBudget()} 点（区域必选 1 个 2 点；地标/势力/氛围各最多 2 个、每个 1 点）。请提供候选池（pool）并让玩家用 op=place_pointbuy picks 选择。`
                : '已选择地点随机：请提供候选池（pool），然后用 op=place_roll 随机抽 1 个区域 + 地标/势力/氛围各 1 个。';
            return commitSetup(setup, text);
          }
          case 'place_pointbuy': {
            const pool = Array.isArray(args.pool)
              ? normalizePool(args.pool)
              : Array.isArray(setup.placeDraft && setup.placeDraft.pool)
                ? setup.placeDraft.pool
                : [];
            if (!pool.length) throw new Error('需要候选池 pool：每项 {id,name,kind}，kind ∈ region/landmark/faction/mood。');
            const picks = Array.isArray(args.picks) ? args.picks.map(String) : [];
            const check = validatePlacement(picks, pool);
            if (!check.valid) throw new Error(`地点选择不合规：${check.errors.join('；')}`);
            setup.placeMethod = 'pointbuy';
            setup.placeDraft = { method: 'pointbuy', pool, selected: check.selected, cost: check.cost, remaining: check.remaining };
            setup.stage = 'place_done';
            return commitSetup(
              setup,
              `地点已选定（花费 ${check.cost}/${locationBudget()} 点）：\n${describePlacement(check.selected)}\n\n确认后 op=place_finalize 写入场景并开始第一幕。`,
            );
          }
          case 'place_roll': {
            const pool = Array.isArray(args.pool)
              ? normalizePool(args.pool)
              : Array.isArray(setup.placeDraft && setup.placeDraft.pool)
                ? setup.placeDraft.pool
                : [];
            if (!pool.length) throw new Error('需要候选池 pool。');
            const result = rollPlacement(pool);
            if (!result.selected.length) throw new Error('候选池不足：至少需要 1 个 region。');
            const cost = 2 + result.selected.filter((x) => x.kind !== 'region').length;
            setup.placeMethod = 'roll';
            setup.placeDraft = { method: 'roll', pool, selected: result.selected, rolls: result.rolls, cost };
            setup.stage = 'place_done';
            const diceLines = result.rolls.map((r) => `${r.id}：${r.dice.join(',')} → ${r.total}`).join('；');
            return commitSetup(
              setup,
              `已随机生成开始地点（不可重掷）：\n${describePlacement(result.selected)}\n骰面：${diceLines}\n\n确认后 op=place_finalize 写入场景并开始第一幕。`,
            );
          }
          case 'place_finalize': {
            const draft = setup.placeDraft;
            if (!draft || !Array.isArray(draft.selected) || !draft.selected.length) {
              throw new Error('还没有地点草稿：先 op=place_pointbuy 或 op=place_roll。');
            }
            const desc = describePlacement(draft.selected);
            const region = draft.selected.find((x) => x.kind === 'region');
            const scene = {
              ...state.scene,
              title: String(args.title || `${region ? region.name : '开局'}·第一幕`),
              location: desc,
              timeLabel: state.clock.label,
              notes: desc,
              updatedAt: new Date().toISOString(),
            };
            setup.stage = 'ready';
            return commit(exec, { ...state, scene, setup: normalizeSetup(setup) }, {
              text: `开局完成，第一幕地点已写入场景：\n${desc}\n\n现在开始叙事；每回合结束时记得推进时间（trpg_time）与团史（trpg_digest）。`,
              value: { scene, stage: 'ready' },
            });
          }
          case 'restart': {
            setup = defaultSetup();
            setup.stage = 'world_q';
            setup.startedAt = new Date().toISOString();
            return commitSetup(setup, '已重置开局流程：回到 20 问世界观问卷（当前团的世界与角色不会被删除，重新生成世界观会覆盖）。');
          }
          case 'skip': {
            setup.skipped = [...setup.skipped, 'manual'];
            setup.stage = 'ready';
            return commitSetup(setup, '已跳过开局流程，可以直接开始游戏（之后仍可用 op=restart 重新走流程）。');
          }
          default:
            throw new Error(`未知的 op「${args.op}」；可用 op：status/questions/record/world/pc_*/place_*/restart/skip。`);
        }
      },
    ),
  );

  return tools;
}
