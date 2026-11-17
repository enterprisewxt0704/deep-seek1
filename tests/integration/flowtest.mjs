/**
 * 开局流程化工具链离线自测：问卷 → 世界 → 车卡（购点）→ 地点 → 第一幕，以及 skip/restart 与阶段门禁。
 * 用 stub ctx + 临时工作区目录，不依赖真实宿主。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'trpg-flow-'));
const { createToolDefinitions } = await import('../../plugin/dsh-trpg-mode/lib/tools.js');
const setupMod = await import('../../plugin/dsh-trpg-mode/lib/setup.js');

const sessions = new Map([
  ['s1', { id: 's1', header: { cwd } }],
  ['s2', { id: 's2', header: { cwd } }],
]);
const ctx = {
  get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined),
};

const projected = new Map();
const handle = { stateOf: (session) => (session && projected.get(session.id)) || null };
const tools = createToolDefinitions(ctx, handle);
const byName = new Map(tools.map((t) => [t.name, t]));
assert.equal(tools.length, 12, `expect 12 tools, got ${tools.map((t) => t.name).join(',')}`);

const run = async (id, name, args) => {
  const tool = byName.get(name);
  assert.ok(tool, `missing tool ${name}`);
  const value = await tool.execute(args, { agent: { id } });
  assert.ok(value && typeof value.text === 'string', `${name} 没有返回文本`);
  if (value.__trpg) projected.set(id, value.__trpg);
  return value;
};

// 1. 新会话：无状态视为 none；未建世界前车卡被门禁拒绝
const status0 = await run('s2', 'trpg_setup', { op: 'status' });
assert.match(status0.text, /阶段：未开始/);
await assert.rejects(() => run('s2', 'trpg_setup', { op: 'pc_method', method: 'pointbuy' }), /还没有世界观/);

// 2. 开新团 → 问卷阶段
const created = await run('s1', 'trpg_world', { op: 'new', world: { name: '雾城', genre: '蒸汽朋克' } });
assert.equal(created.__trpg.setup.stage, 'world_q');
const status1 = await run('s1', 'trpg_setup', { op: 'status' });
assert.match(status1.text, /world_q/);
assert.match(status1.text, /已答 0\/20/);

// 3. 取题 + 按默认答案作答
const q = await run('s1', 'trpg_setup', { op: 'questions', group: 'g1' });
assert.match(q.text, /q1/);
const answers = setupMod.allQuestions().map((item) => ({ id: item.id, answer: item.default }));
await run('s1', 'trpg_setup', { op: 'record', answers });
const status2 = await run('s1', 'trpg_setup', { op: 'status' });
assert.match(status2.text, /已答 20\/20/);

// 4. 生成世界观（快速补齐默认答案）
const world = await run('s1', 'trpg_setup', {
  op: 'world',
  quick: true,
  world: { name: '雾城', genre: '蒸汽朋克', summary: '雾锁之城，蒸汽与阴谋' },
});
assert.equal(world.__trpg.setup.stage, 'world_ready');
assert.equal(world.__trpg.world.name, '雾城');
assert.equal(world.__trpg.campaign.name, '雾城');
assert.equal(world.__trpg.setup.worldDraft.name, '雾城');
assert.equal(setupMod.answeredCount(world.__trpg.setup), 20, '快速开局应补齐 20 问');

// 5. 车卡：购点
const method = await run('s1', 'trpg_setup', { op: 'pc_method', method: 'pointbuy', template: 'd20' });
assert.equal(method.__trpg.setup.stage, 'pc_build');
const attrs = Object.fromEntries(setupMod.POINT_BUY_TEMPLATES.d20.attributes.map((a) => [a, 10]));
const pointbuy = await run('s1', 'trpg_setup', { op: 'pc_pointbuy', template: 'd20', alloc: attrs });
assert.match(pointbuy.text, /分配合法/);
const pc = await run('s1', 'trpg_setup', { op: 'pc_finalize', name: '林', background: '钟表匠学徒', goal: '查清雾的来历' });
assert.equal(pc.__trpg.setup.stage, 'place_method');
assert.equal(pc.__trpg.pc.name, '林');
assert.equal(Object.keys(pc.__trpg.pc.attributes).length, 6);

// 6. 开始地点：购点（区域 2 点 + 地标 1 点）
const pool = [
  { id: 'r1', name: '旧港', kind: 'region' },
  { id: 'l1', name: '钟楼', kind: 'landmark' },
  { id: 'f1', name: '行会', kind: 'faction' },
  { id: 'm1', name: '浓雾', kind: 'mood' },
];
await run('s1', 'trpg_setup', { op: 'place_method', method: 'pointbuy', pool });
const place = await run('s1', 'trpg_setup', { op: 'place_pointbuy', picks: ['r1', 'l1'] });
assert.equal(place.__trpg.setup.stage, 'place_done');
await assert.rejects(() => run('s1', 'trpg_setup', { op: 'place_pointbuy', picks: ['l1'] }), /不合规/);

// 7. 写入场景 → 第一幕
const final = await run('s1', 'trpg_setup', { op: 'place_finalize', title: '楔子：雾中钟声' });
assert.equal(final.__trpg.setup.stage, 'ready');
assert.equal(final.__trpg.scene.title, '楔子：雾中钟声');
assert.match(final.__trpg.scene.location, /旧港/);

// 8. recap 不再提示开局流程，且带上世界与角色
const recap = await run('s1', 'trpg_recall', {});
assert.match(recap.text, /雾城/);
assert.match(recap.text, /林/);
assert.doesNotMatch(recap.text, /开局流程：/);

// 9. restart / skip
const restarted = await run('s2', 'trpg_setup', { op: 'restart' });
assert.equal(restarted.__trpg.setup.stage, 'world_q');
const skipped = await run('s2', 'trpg_setup', { op: 'skip' });
assert.equal(skipped.__trpg.setup.stage, 'ready');
assert.ok(skipped.__trpg.setup.skipped.length > 0);

// 10. 落盘：新团有独立团文件，旧全局 state.json 不参与
const campaignsDir = path.join(cwd, '.trpg', 'campaigns');
const files = await fs.readdir(campaignsDir);
assert.ok(files.length >= 1, '应写入团检查点文件');
const save0 = JSON.parse(await fs.readFile(path.join(campaignsDir, files[0]), 'utf8'));
assert.equal(save0.format, 'dsh-trpg-save');
assert.equal(save0.state.campaign.id !== undefined, true);

console.log(JSON.stringify({ ok: true, tools: tools.length, campaigns: files.length, finalStage: final.__trpg.setup.stage }));
