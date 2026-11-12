/**
 * 存档 / 团状态文件读写（node:fs）。
 *
 * 目录结构（全部在工作区 `.trpg/` 下）：
 *   campaigns/<campaignId>.json   每个团一份自动检查点（状态按团隔离）
 *   sessions/<sessionId>.json     会话 → 团 的映射（重开/换会话也能找回自己的团）
 *   saves/<campaignId>__<slot>__<stamp>.json  手动存档（文件名带团 id，避免串团）
 *   saves/latest.json             最近一次存档（全局，兼容旧数据）
 *   saves/latest__<campaignId>.json  每个团最近一次存档
 *   state.json                    旧版全局状态（只用于一次性迁移，不再写入）
 */
import fs from 'node:fs/promises';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  defaultState,
  normalizeState,
  nowStamp,
  slugify,
  stateForDisk,
} from './state.js';

export function trpgRoot(cwd) {
  return path.join(cwd || process.cwd(), '.trpg');
}

export function savesDir(cwd) {
  return path.join(trpgRoot(cwd), 'saves');
}

export function campaignsDir(cwd) {
  return path.join(trpgRoot(cwd), 'campaigns');
}

export function sessionsDir(cwd) {
  return path.join(trpgRoot(cwd), 'sessions');
}

/** 旧版全局状态文件；仅用于迁移。 */
export function legacyStateFile(cwd) {
  return path.join(trpgRoot(cwd), 'state.json');
}

export function campaignFile(cwd, campaignId) {
  return path.join(campaignsDir(cwd), `${campaignId}.json`);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureDirSync(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 目录已存在或无权限，交给后续写入决定
  }
}

function writeJsonSync(file, value) {
  ensureDirSync(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** 生成本团 id：团名 slug + 4 位随机后缀（创建后保持不变）。 */
export function makeCampaignId(name) {
  const base = slugify(name || 'trpg');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base.slice(0, 40)}-${rand}`;
}

/** 自动检查点：每团一份，绝不写到别的团。 */
export async function writeCheckpoint(cwd, state) {
  const campaignId = String(state?.campaign?.id || '').trim();
  if (!campaignId) return null; // 还没建团，不落盘，避免污染旧团
  try {
    await writeJson(campaignFile(cwd, campaignId), {
      format: SAVE_FORMAT,
      version: SAVE_VERSION,
      auto: true,
      campaignId,
      createdAt: new Date().toISOString(),
      state: stateForDisk(state),
    });
    return campaignFile(cwd, campaignId);
  } catch {
    return null;
  }
}

/** 会话 → 团 映射；用于新回合/重开后找回本会话的团。 */
export async function writeSessionBinding(cwd, sessionId, campaignId) {
  if (!sessionId || !campaignId) return null;
  try {
    const file = path.join(sessionsDir(cwd), `${String(sessionId).replace(/[^\w.-]+/g, '_')}.json`);
    await writeJson(file, { sessionId, campaignId, updatedAt: new Date().toISOString() });
    return file;
  } catch {
    return null;
  }
}

export async function readSessionBinding(cwd, sessionId) {
  if (!sessionId) return null;
  try {
    const file = path.join(sessionsDir(cwd), `${String(sessionId).replace(/[^\w.-]+/g, '_')}.json`);
    const raw = await readJson(file);
    return typeof raw?.campaignId === 'string' ? raw.campaignId : null;
  } catch {
    return null;
  }
}

export async function readCampaign(cwd, campaignId) {
  if (!campaignId) return null;
  try {
    const raw = await readJson(campaignFile(cwd, campaignId));
    const body = raw?.state ?? raw;
    const state = normalizeState(body);
    if (!state.campaign.id) state.campaign.id = campaignId;
    return state;
  } catch {
    return null;
  }
}

function campaignSummary(campaignId, state) {
  return {
    id: campaignId,
    name: state.campaign?.name || state.world?.name || '未命名',
    system: state.campaign?.system || state.world?.genre || '',
    worldName: state.world?.name || '',
    genre: state.world?.genre || '',
    pcName: state.pc?.name || '',
    level: state.pc?.level || 1,
    sceneTitle: state.scene?.title || '',
    clockLabel: state.clock?.label || '',
    updatedAt: state.lastUpdated || null,
  };
}

/** 把存档归到团上：先按 campaignId，旧存档没有 id 时按团名匹配。 */
function attachSaves(campaigns, saves) {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const byName = new Map();
  for (const c of campaigns) {
    const name = String(c.name || '').trim();
    if (name && !byName.has(name)) byName.set(name, c);
  }
  for (const s of saves) {
    let campaign = byId.get(String(s.campaignId || ''));
    if (!campaign) {
      const name = String(s.campaign || '').trim();
      if (name) campaign = byName.get(name);
    }
    if (campaign) {
      s.campaignId = campaign.id;
      campaign.saveCount = (campaign.saveCount || 0) + 1;
    }
  }
}

/** 扫描所有团，返回 {campaigns:[summary], saves:[meta], activeCampaignId}。 */
export async function buildLibrary(cwd, activeState) {
  try {
    await migrateLegacyState(cwd);
  } catch {
    // 旧文件不可读时忽略
  }
  const campaigns = [];
  for (const name of await safeReaddir(campaignsDir(cwd))) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readJson(path.join(campaignsDir(cwd), name));
      const state = normalizeState(raw?.state ?? raw);
      const id = String(raw?.campaignId || state.campaign?.id || name.replace(/\.json$/, ''));
      state.campaign.id = id;
      campaigns.push(campaignSummary(id, state));
    } catch {
      // 跳过损坏团文件
    }
  }
  const saves = await listSaves(cwd);
  attachSaves(campaigns, saves);
  campaigns.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return {
    activeCampaignId: String(activeState?.campaign?.id || ''),
    campaigns,
    saves: saves.map((s) => ({
      file: s.file,
      name: s.name,
      campaignId: s.campaignId,
      campaign: s.campaign,
      slot: s.slot,
      note: s.note,
      createdAt: s.createdAt,
      bytes: s.bytes,
    })),
  };
}

/** 旧版 `.trpg/state.json` → 一次迁移为独立团文件（原文件改名留存）。 */
export async function migrateLegacyState(cwd) {
  const legacy = legacyStateFile(cwd);
  try {
    const raw = await readJson(legacy);
    const state = normalizeState(raw?.state ?? raw);
    if (!state.campaign.id) state.campaign.id = makeCampaignId(state.campaign.name || state.world.name);
    state.lastUpdated = state.lastUpdated || new Date().toISOString();
    await writeCheckpoint(cwd, state);
    await fs.rename(legacy, path.join(trpgRoot(cwd), `legacy-state-${nowStamp()}.json`)).catch(() => {});
    return state;
  } catch {
    return null;
  }
}

/**
 * 迁移的同步版本：投影 `init()` 是同步钩子，必须能在第一次工具调用之前
 * 就把旧 `state.json` 迁移成独立团，否则面板下拉里会看不到旧团。
 * 文件不存在时直接返回，开销只有一次 stat 级别的读取尝试。
 */
export function migrateLegacyStateSync(cwd) {
  const legacy = legacyStateFile(cwd);
  try {
    const raw = JSON.parse(readFileSync(legacy, 'utf8'));
    const state = normalizeState(raw?.state ?? raw);
    if (!state.campaign.id) state.campaign.id = makeCampaignId(state.campaign.name || state.world.name);
    state.lastUpdated = state.lastUpdated || new Date().toISOString();
    if (!state.campaign.id) return null;
    writeJsonSync(campaignFile(cwd, state.campaign.id), {
      format: SAVE_FORMAT,
      version: SAVE_VERSION,
      auto: true,
      campaignId: state.campaign.id,
      createdAt: new Date().toISOString(),
      state: stateForDisk(state),
    });
    try {
      renameSync(legacy, path.join(trpgRoot(cwd), `legacy-state-${nowStamp()}.json`));
    } catch {
      // 改名失败时旧文件仍在，下次再试；团文件已按同一 id 写入，不会重复建团
    }
    return state;
  } catch {
    return null;
  }
}

function savePayload(state, { slot, note } = {}) {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    createdAt: new Date().toISOString(),
    slot: String(slot || 'manual'),
    note: String(note || ''),
    campaignId: String(state?.campaign?.id || ''),
    campaign: state?.campaign?.name || '',
    state: stateForDisk(state),
  };
}

const saveBaseName = (state) => {
  const campaignId = String(state?.campaign?.id || '').trim();
  if (campaignId) return `${campaignId}__${slugify(state?.campaign?.name || 'trpg')}`;
  return `unassigned__${slugify(state?.campaign?.name || 'trpg')}`;
};

export async function writeSave(cwd, state, { slot, note } = {}) {
  const dir = savesDir(cwd);
  const safeSlot = slugify(slot || 'manual', 'manual');
  const file = path.join(dir, `${saveBaseName(state)}__${safeSlot}__${nowStamp()}.json`);
  const payload = savePayload(state, { slot: safeSlot, note });
  await writeJson(file, payload);
  await writeJson(path.join(dir, 'latest.json'), payload);
  if (payload.campaignId) {
    await writeJson(path.join(dir, `latest__${payload.campaignId}.json`), payload).catch(() => {});
  }
  return { file, slot: safeSlot, note: payload.note, createdAt: payload.createdAt, campaignId: payload.campaignId };
}

export async function listSaves(cwd) {
  const dir = savesDir(cwd);
  const out = [];
  for (const name of await safeReaddir(dir)) {
    if (!name.endsWith('.json') || name === 'latest.json' || name.startsWith('latest__')) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      const raw = await readJson(file);
      const normalized = normalizeState(raw.state ?? raw);
      out.push({
        file,
        name,
        slot: raw.slot || '',
        note: raw.note || '',
        createdAt: raw.createdAt || '',
        campaignId: String(raw.campaignId || normalized.campaign.id || ''),
        campaign: raw.campaign || normalized.campaign.name || '',
        bytes: stat.size,
      });
    } catch {
      // 跳过损坏文件
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

function insideSaves(cwd, file) {
  const root = path.resolve(savesDir(cwd));
  const abs = path.resolve(file);
  return abs === root || abs.startsWith(root + path.sep);
}

/** 按团名找回已有团的 id：用于把旧版（无 campaignId）存档接回同名团，避免再建一个重复团。 */
async function findCampaignIdByName(cwd, name) {
  const wanted = String(name || '').trim();
  if (!wanted) return '';
  try {
    for (const file of await safeReaddir(campaignsDir(cwd))) {
      if (!file.endsWith('.json')) continue;
      const raw = await readJson(path.join(campaignsDir(cwd), file));
      const state = normalizeState(raw?.state ?? raw);
      if (state.campaign.name === wanted) return state.campaign.id || path.basename(file, '.json');
    }
  } catch {
    // 没有团目录或文件损坏
  }
  return '';
}

export async function readSave(cwd, { file, slot, latest, campaignId } = {}) {
  const dir = savesDir(cwd);
  let target = '';
  if (file) {
    target = path.isAbsolute(file) ? file : path.join(dir, file);
    if (!insideSaves(cwd, target)) throw new Error('存档路径必须位于 .trpg/saves 目录内');
  } else if (campaignId) {
    target = path.join(dir, `latest__${campaignId}.json`);
  } else if (latest || !slot) {
    target = path.join(dir, 'latest.json');
  } else {
    const saves = await listSaves(cwd);
    const match = saves.find((s) => s.slot === slot || s.name === slot || s.file === path.join(dir, slot));
    if (!match) throw new Error(`找不到槽位为 ${slot} 的存档，可用 trpg_load 的 list 操作查看`);
    target = match.file;
  }
  const raw = await readJson(target);
  const body = raw?.state ?? raw;
  const state = normalizeState(body);
  if (!state.campaign.id) state.campaign.id = String(raw?.campaignId || '');
  if (!state.campaign.id && state.campaign.name) {
    state.campaign.id = await findCampaignIdByName(cwd, state.campaign.name);
  }
  return {
    file: target,
    slot: raw?.slot || '',
    note: raw?.note || '',
    createdAt: raw?.createdAt || '',
    campaignId: String(raw?.campaignId || state.campaign.id || ''),
    state,
  };
}

export async function deleteSave(cwd, { file, campaignId, name, slot } = {}) {
  const dir = savesDir(cwd);
  const all = await listSaves(cwd);
  let target = '';
  if (file) {
    const wanted = path.isAbsolute(file) ? file : path.join(dir, file);
    const base = path.basename(wanted);
    const match = all.find((s) => path.resolve(s.file) === path.resolve(wanted) || s.name === base);
    if (match) target = match.file;
    else if (path.isAbsolute(file) || insideSaves(cwd, wanted)) target = wanted;
    else throw new Error(`找不到存档：${file}（可用 trpg_save op=list 查看）`);
    if (!insideSaves(cwd, target)) throw new Error('存档路径必须位于 .trpg/saves 目录内');
  } else if (name || slot) {
    const match = all.find((s) => s.name === (name || slot) || path.basename(s.file) === (name || slot)) ||
      all.find((s) => s.slot === (name || slot));
    if (!match) throw new Error(`找不到存档：${name || slot}（可用 trpg_save op=list 查看）`);
    target = match.file;
  } else if (campaignId) {
    const own = all.filter((s) => s.campaignId === campaignId);
    if (own.length === 0) throw new Error('该团没有存档可删除');
    const removed = [];
    for (const s of own) {
      await fs.unlink(s.file).catch(() => {});
      removed.push(s.name);
    }
    return { removed };
  } else {
    throw new Error('删除存档需要 file、name、slot 或 campaignId');
  }
  await fs.unlink(target);
  return { removed: [path.basename(target)] };
}

function safeReaddirSync(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * `buildLibrary` 的同步版本：供会话投影 `init(header)` 在任何工具调用之前
 * 播种「团 / 存档索引」，这样面板一打开就能列出并选择工作区里已有的团。
 * 只读索引，不改变任何团的状态。
 */
export function buildLibrarySync(cwd, activeState) {
  try {
    migrateLegacyStateSync(cwd);
  } catch {
    // 迁移失败时仍返回当前索引
  }
  const campaigns = [];
  for (const name of safeReaddirSync(campaignsDir(cwd))) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(campaignsDir(cwd), name), 'utf8'));
      const state = normalizeState(raw?.state ?? raw);
      const id = String(raw?.campaignId || state.campaign?.id || name.replace(/\.json$/, ''));
      state.campaign.id = id;
      campaigns.push(campaignSummary(id, state));
    } catch {
      // 跳过损坏团文件
    }
  }
  const dir = savesDir(cwd);
  const saves = [];
  for (const name of safeReaddirSync(dir)) {
    if (!name.endsWith('.json') || name === 'latest.json' || name.startsWith('latest__')) continue;
    try {
      const file = path.join(dir, name);
      const stat = statSync(file);
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      saves.push({
        file,
        name,
        slot: raw.slot || '',
        note: raw.note || '',
        createdAt: raw.createdAt || '',
        campaignId: String(raw.campaignId || raw.state?.campaign?.id || ''),
        campaign: raw.campaign || raw.state?.campaign?.name || '',
        bytes: stat.size,
      });
    } catch {
      // 跳过损坏存档
    }
  }
  saves.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  attachSaves(campaigns, saves);
  campaigns.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return {
    activeCampaignId: String(activeState?.campaign?.id || ''),
    campaigns,
    saves: saves.map((s) => ({
      file: s.file,
      name: s.name,
      campaignId: s.campaignId,
      campaign: s.campaign,
      slot: s.slot,
      note: s.note,
      createdAt: s.createdAt,
      bytes: s.bytes,
    })),
  };
}

/** 新建一个空团（返回带新 campaign.id 的状态）。 */
export function freshCampaign(name = '') {
  const base = defaultState();
  const id = makeCampaignId(name);
  base.campaign.id = id;
  base.campaign.name = name;
  base.campaign.startedAt = new Date().toISOString();
  base.lastUpdated = new Date().toISOString();
  return base;
}
