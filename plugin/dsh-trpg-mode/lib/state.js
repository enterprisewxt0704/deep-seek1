/**
 * 跑团模式共享状态模型：默认状态、归一化、骰子与时间工具。
 * 该文件同时被 Host 半边（投影/工具）使用；不得依赖任何 Harness 运行时包。
 */

export const PROJECTION_KEY = 'trpg';
/** v3：状态按团隔离（campaign.id + library 索引），面板可切换显示哪个团。 */
export const STATE_VERSION = 3;
export const SAVE_FORMAT = 'dsh-trpg-save';
export const SAVE_VERSION = 3;

const DICE_PRESETS = [
  ['d4', 4],
  ['d6', 6],
  ['d8', 8],
  ['d10', 10],
  ['d12', 12],
  ['d20', 20],
  ['d100', 100],
];

export function defaultDiceProfiles() {
  return DICE_PRESETS.map(([id, sides]) => ({
    id,
    name: id.toUpperCase(),
    sides,
    weights: null,
    explode: false,
  }));
}

export function defaultLibrary() {
  return { activeCampaignId: '', campaigns: [], saves: [] };
}

export function defaultState() {
  return {
    campaign: { id: '', name: '', system: '', startedAt: null },
    world: {
      name: '',
      genre: '',
      summary: '',
      tone: '',
      rules: [],
      factions: [],
      locations: [],
      hooks: [],
      notes: '',
    },
    pc: {
      name: '',
      race: '',
      class: '',
      level: 1,
      attributes: {},
      skills: {},
      hp: { cur: 10, max: 10 },
      mp: { cur: 0, max: 0 },
      ac: 10,
      inventory: [],
      conditions: [],
      xp: 0,
      notes: '',
    },
    scene: {
      title: '',
      location: '',
      timeLabel: '',
      participants: [],
      goal: '',
      notes: '',
      updatedAt: null,
    },
    flags: {},
    rolls: [],
    digests: [],
    diceConfig: {
      defaultId: 'd20',
      profiles: defaultDiceProfiles(),
    },
    timeConfig: { mode: 'estimate', minutesPerTurn: 10 },
    clock: { elapsedMinutes: 0, label: '第1天 08:00' },
    compactionLog: [],
    /** 团列表与存档索引（由 Host 在每次提交时重建，不写入每团存档文件）。 */
    library: defaultLibrary(),
    lastUpdated: null,
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);

function mergeObj(base, raw) {
  const out = { ...base };
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isObj(v) && isObj(out[k])) out[k] = mergeObj(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function normalizeProfiles(raw) {
  const list = arr(raw)
    .filter((p) => isObj(p) && typeof p.id === 'string' && p.id)
    .map((p) => ({
      id: str(p.id, 'd20'),
      name: str(p.name, str(p.id, 'd20').toUpperCase()),
      sides: Math.max(2, Math.min(1000, Math.round(num(p.sides, 20)))),
      weights:
        Array.isArray(p.weights) && p.weights.length > 0
          ? p.weights.map((w) => Math.max(0, num(w, 1)))
          : null,
      explode: bool(p.explode, false),
    }));
  if (list.length === 0) return defaultDiceProfiles();
  return list;
}

/** 把任意输入（存档 / 事件 meta / 旧版状态）归一化为完整状态。 */
export function normalizeState(raw) {
  const base = defaultState();
  const s = mergeObj(base, isObj(raw) ? raw : {});

  s.campaign = mergeObj(base.campaign, s.campaign);
  s.campaign.id = str(s.campaign.id);
  s.campaign.name = str(s.campaign.name);
  s.campaign.system = str(s.campaign.system);
  s.campaign.startedAt = s.campaign.startedAt ?? null;

  s.world = mergeObj(base.world, s.world);
  for (const key of ['rules', 'factions', 'locations', 'hooks']) s.world[key] = arr(s.world[key]).slice(0, 200);
  for (const key of ['name', 'genre', 'summary', 'tone', 'notes']) s.world[key] = str(s.world[key]);

  // 团名/系统没显式给出时用世界信息兜底，面板与 /trpg-recap 就不会显示「未命名」。
  if (!s.campaign.name) s.campaign.name = s.world.name;
  if (!s.campaign.system) s.campaign.system = s.world.genre;

  s.pc = mergeObj(base.pc, s.pc);
  s.pc.level = Math.max(1, Math.min(99, Math.round(num(s.pc.level, 1))));
  s.pc.hp = mergeObj(base.pc.hp, s.pc.hp);
  s.pc.mp = mergeObj(base.pc.mp, s.pc.mp);
  s.pc.ac = num(s.pc.ac, 10);
  s.pc.xp = num(s.pc.xp, 0);
  s.pc.inventory = arr(s.pc.inventory).slice(0, 200);
  s.pc.conditions = arr(s.pc.conditions).slice(0, 50);
  if (!isObj(s.pc.attributes)) s.pc.attributes = {};
  if (!isObj(s.pc.skills)) s.pc.skills = {};

  s.scene = mergeObj(base.scene, s.scene);
  s.scene.participants = arr(s.scene.participants).slice(0, 50);

  s.rolls = arr(s.rolls).slice(-100);
  s.digests = arr(s.digests).slice(-30);
  s.compactionLog = arr(s.compactionLog).slice(-30);

  s.diceConfig = mergeObj(base.diceConfig, s.diceConfig);
  s.diceConfig.profiles = normalizeProfiles(s.diceConfig.profiles);
  const defaultId = str(s.diceConfig.defaultId, 'd20');
  s.diceConfig.defaultId = s.diceConfig.profiles.some((p) => p.id === defaultId)
    ? defaultId
    : s.diceConfig.profiles[0].id;

  s.timeConfig = mergeObj(base.timeConfig, s.timeConfig);
  s.timeConfig.mode = s.timeConfig.mode === 'fixed' ? 'fixed' : 'estimate';
  s.timeConfig.minutesPerTurn = Math.max(1, Math.round(num(s.timeConfig.minutesPerTurn, 10)));

  s.clock = mergeObj(base.clock, s.clock);
  s.clock.elapsedMinutes = Math.max(0, num(s.clock.elapsedMinutes, 0));
  s.clock.label = formatClock(s.clock.elapsedMinutes);

  s.flags = isObj(s.flags) ? s.flags : {};
  s.library = mergeObj(defaultLibrary(), isObj(s.library) ? s.library : {});
  s.library.activeCampaignId = str(s.library.activeCampaignId);
  s.library.campaigns = arr(s.library.campaigns).filter(isObj).slice(0, 80);
  s.library.saves = arr(s.library.saves).filter(isObj).slice(0, 400);
  s.lastUpdated = s.lastUpdated ?? null;
  return s;
}

/** 写盘/存档前剥掉索引快照（library 每次提交都从磁盘重建，不属于团本身）。 */
export function stateForDisk(state) {
  const copy = normalizeState(state);
  delete copy.library;
  return copy;
}

export function formatClock(elapsedMinutes) {
  const total = 8 * 60 + Math.max(0, Math.round(elapsedMinutes || 0));
  const day = Math.floor(total / 1440) + 1;
  const minuteOfDay = total % 1440;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `第${day}天 ${hh}:${mm}`;
}

export function slugify(name, fallback = 'trpg') {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 48) || fallback;
}

export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function pickIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * 掷一颗骰。weights 为各面权重数组（长度 = sides，null 表示均匀）。
 * 返回 { sides, value, weighted }。
 */
export function rollOne(sides, weights = null, rng = Math.random) {
  const n = Math.max(2, Math.min(1000, Math.round(sides)));
  let face;
  let weighted = false;
  if (Array.isArray(weights) && weights.length === n) {
    const norm = weights.map((w) => Math.max(0, Number(w) || 0));
    const any = norm.some((w) => w > 0);
    if (any) {
      face = pickIndex(norm, rng) + 1;
      weighted = true;
    }
  }
  if (face === undefined) face = Math.floor(rng() * n) + 1;
  return { sides: n, value: face, weighted };
}

export function resolveOutcome(rolls, total, target) {
  const natural = rolls.length === 1 ? rolls[0].value : null;
  const sides = rolls.length === 1 ? rolls[0].sides : null;
  let outcome = 'none';
  if (target && Number.isFinite(Number(target.value))) {
    const value = Number(target.value);
    if (target.type === 'le') outcome = total <= value ? 'success' : 'fail';
    else outcome = total >= value ? 'success' : 'fail';
  }
  if (sides === 20 && natural === 20) outcome = 'critical';
  else if (sides === 20 && natural === 1) outcome = 'critical-fail';
  else if (sides === 100 && natural !== null) {
    if (natural <= 5) outcome = 'critical';
    else if (natural >= 96) outcome = 'critical-fail';
  }
  return outcome;
}

export function rollSummaryText(roll) {
  const dice = roll.dice.map((d) => `${d.value}${d.weighted ? 'w' : ''}`).join('+');
  const mod = roll.modifier ? (roll.modifier > 0 ? `+${roll.modifier}` : `${roll.modifier}`) : '';
  const label = roll.label ? `「${roll.label}」` : '';
  const target = roll.target ? `（目标 ${roll.target.type === 'le' ? '≤' : '≥'}${roll.target.value}）` : '';
  const outcomeText =
    roll.outcome === 'critical'
      ? '大成功'
      : roll.outcome === 'critical-fail'
        ? '大失败'
        : roll.outcome === 'success'
          ? '成功'
          : roll.outcome === 'fail'
            ? '失败'
            : '无判定';
  return `${label}${dice}${mod} = ${roll.total}${target} → ${outcomeText}`;
}
