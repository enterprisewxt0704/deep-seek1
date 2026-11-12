/**
 * 跑团模式 v3 工具链离线自测：团隔离 / 切团 / 存档管理 / 旧数据迁移。
 * 用 stub ctx + 临时工作区目录，不依赖真实宿主。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'trpg-tools3-'));
const { createToolDefinitions } = await import('../plugin/dsh-trpg-mode/lib/tools.js');

// 旧版全局检查点：应被迁移成独立团，但不会自动挂到任何会话
await fs.mkdir(path.join(cwd, '.trpg'), { recursive: true });
await fs.writeFile(
  path.join(cwd, '.trpg', 'state.json'),
  JSON.stringify({
    format: 'dsh-trpg-save',
    version: 2,
    state: {
      campaign: { name: '旧团', system: '旧系统' },
      world: { name: '旧团', genre: '旧系统' },
      pc: { name: '旧角色' },
      rolls: [{ sides: 20, value: 20, total: 20, label: '旧骰点' }],
    },
  }),
  'utf8',
);

const sessions = new Map([
  ['s1', { id: 's1', header: { cwd } }],
  ['s2', { id: 's2', header: { cwd } }],
]);
const ctx = {
  get: (name) =>
    name === 'sessions'
      ? { get: (id) => sessions.get(id) }
      : undefined,
};

// 模拟会话投影：从每次工具结果的 meta.trpg 更新
const projected = new Map();
const handle = {
  stateOf: (session) => (session && projected.get(session.id)) || null,
};

const tools = createToolDefinitions(ctx, handle);
const byName = new Map(tools.map((t) => [t.name, t]));
assert.equal(tools.length, 11, `expect 11 tools, got ${tools.map((t) => t.name).join(',')}`);

const execOf = (id) => ({ agent: { id } });
const run = async (id, name, args) => {
  const tool = byName.get(name);
  assert.ok(tool, `missing tool ${name}`);
  const value = await tool.execute(args, execOf(id));
  assert.ok(value && typeof value.text === 'string', `${name} returned no text`);
  if (value.__trpg) projected.set(id, value.__trpg);
  return value;
};

// 0) 旧数据迁移：第一次读取触发，旧文件改名为 legacy-state-*
let v = await run('s1', 'trpg_world', { op: 'get' });
assert.ok(v.text.includes('未创建'), '新会话不应继承旧团');
let root = await fs.readdir(path.join(cwd, '.trpg'));
assert.ok(root.some((f) => f.startsWith('legacy-state-')), root.join(','));
const campaignsDir = path.join(cwd, '.trpg', 'campaigns');
assert.equal((await fs.readdir(campaignsDir)).length, 1, '旧团应迁移成 1 个团文件');

// 1) s1 建 A 团
v = await run('s1', 'trpg_world', {
  op: 'create',
  world: { name: 'A港', genre: '蒸汽朋克', summary: '雾夜港口', rules: ['d20'] },
});
const cidA = v.__trpg.campaign.id;
assert.ok(cidA, '团 id 应生成');
assert.equal(v.__trpg.campaign.name, 'A港');
assert.equal(v.__trpg.library.activeCampaignId, cidA, 'library 应标出当前团');
assert.ok(v.__trpg.library.campaigns.some((c) => c.name === '旧团'), 'library 应包含迁移来的旧团');

v = await run('s1', 'trpg_sheet', {
  op: 'create',
  sheet: { name: '甲角色', race: '人类', class: '侦探', level: 3, hp: { cur: 20, max: 20 } },
});
assert.equal(v.__trpg.pc.name, '甲角色');
v = await run('s1', 'trpg_roll', { label: 'A团骰点', target: { type: 'ge', value: 1 } });
assert.equal(v.__trpg.rolls.length, 1);

// 2) s2 同 cwd 的另一会话：绝不能看到 A 团
v = await run('s2', 'trpg_world', { op: 'get' });
assert.ok(v.text.includes('未创建'), 's2 不应看到 A 团世界观');
v = await run('s2', 'trpg_recall', {});
assert.ok(!v.text.includes('甲角色') && !v.text.includes('A港'), 's2 不应串到 A 团');

// 3) s2 建 B 团
v = await run('s2', 'trpg_world', {
  op: 'create',
  world: { name: 'B岛', genre: '克苏鲁', summary: '孤岛灯塔' },
});
const cidB = v.__trpg.campaign.id;
assert.ok(cidB && cidB !== cidA, '两个团应有不同 id');
assert.equal(v.__trpg.rolls.length, 0, 'B 团不应带 A 团的骰点');
v = await run('s2', 'trpg_sheet', { op: 'create', sheet: { name: '乙角色', class: '记者', level: 1 } });
assert.equal(v.__trpg.pc.name, '乙角色');

// 4) 两边状态互不影响
v = await run('s1', 'trpg_recall', {});
assert.ok(v.text.includes('A港') && v.text.includes('甲角色'));
assert.ok(!v.text.includes('B岛') && !v.text.includes('乙角色'));

// 5) 团列表 / 切换
v = await run('s1', 'trpg_campaigns', { op: 'list' });
assert.ok(v.text.includes('A港') && v.text.includes('B岛') && v.text.includes('旧团'));
assert.ok(v.text.includes('当前团'));
v = await run('s1', 'trpg_campaigns', { op: 'open', name: 'B岛' });
assert.equal(v.__trpg.campaign.id, cidB);
assert.equal(v.__trpg.pc.name, '乙角色', '切团后应载入 B 团角色');
v = await run('s1', 'trpg_campaigns', { op: 'open', id: cidA });
assert.equal(v.__trpg.pc.name, '甲角色');

// 6) 存档：A 团存档 + B 团存档，文件名带团 id
v = await run('s1', 'trpg_save', { op: 'save', slot: 'a1', note: 'A团存档' });
assert.equal(v.text.includes('A港'), true);
const savesDir = path.join(cwd, '.trpg', 'saves');
let files = await fs.readdir(savesDir);
assert.ok(files.some((f) => f.startsWith(`${cidA}__`) && f.includes('__a1__')), files.join(','));
await run('s1', 'trpg_campaigns', { op: 'open', name: 'B岛' });
await run('s1', 'trpg_save', { op: 'save', slot: 'b1', note: 'B团存档' });
files = await fs.readdir(savesDir);
assert.ok(files.some((f) => f.startsWith(`${cidB}__`) && f.includes('__b1__')), files.join(','));

v = await run('s1', 'trpg_save', { op: 'list' });
assert.ok(v.text.includes('A团存档') && v.text.includes('B团存档'));

// 7) 读档：在 B 团会话里读 A 团存档 → 切回 A
const aSaveFile = files.find((f) => f.startsWith(`${cidA}__`) && f.includes('__a1__'));
v = await run('s1', 'trpg_load', { file: aSaveFile });
assert.equal(v.__trpg.campaign.id, cidA);
assert.equal(v.__trpg.pc.name, '甲角色');
assert.equal(v.__trpg.rolls.length, 1);

// 8) campaignId 读该团最近存档
v = await run('s1', 'trpg_load', { campaignId: cidB });
assert.equal(v.__trpg.campaign.id, cidB);
assert.equal(v.__trpg.pc.name, '乙角色');

// 8.1) 不带参数时读取「当前团」最近存档，而不是别的团
v = await run('s1', 'trpg_load', {});
assert.equal(v.__trpg.campaign.id, cidB, '默认读档必须留在当前团');
assert.equal(v.__trpg.pc.name, '乙角色');

// 9) 删除存档
v = await run('s1', 'trpg_save', { op: 'delete', campaignId: cidB });
assert.ok(v.text.includes('已删除存档'));
files = await fs.readdir(savesDir);
assert.ok(!files.some((f) => f.startsWith(`${cidB}__`) && !f.startsWith('latest__')), files.join(','));

// 9.1) 按文件名删除单条存档（面板「删这个档」的路径）
await run('s1', 'trpg_campaigns', { op: 'open', name: 'A港' });
await run('s1', 'trpg_save', { op: 'save', slot: 'tmp-del', note: '待删除' });
files = await fs.readdir(savesDir);
const tmpSave = files.find((f) => f.startsWith(`${cidA}__`) && f.includes('__tmp-del__'));
assert.ok(tmpSave, '应生成待删除存档');
v = await run('s1', 'trpg_save', { op: 'delete', name: tmpSave });
assert.ok(v.text.includes('已删除存档'));
files = await fs.readdir(savesDir);
assert.ok(!files.includes(tmpSave), '按文件名删除失败');

// 10) 磁盘上的团文件不含 library（避免自我膨胀），会话映射按会话隔离
const campaignRaw = JSON.parse(await fs.readFile(path.join(campaignsDir, `${cidA}.json`), 'utf8'));
const inner = campaignRaw.state ?? campaignRaw;
assert.equal(inner.library, undefined, '团文件不应保存 library');
assert.equal(inner.world.name, 'A港');
const sessionsDir = path.join(cwd, '.trpg', 'sessions');
const bind1 = JSON.parse(await fs.readFile(path.join(sessionsDir, 's1.json'), 'utf8'));
const bind2 = JSON.parse(await fs.readFile(path.join(sessionsDir, 's2.json'), 'utf8'));
assert.equal(bind1.campaignId, cidA, 's1 最后打开的应是 A 团');
assert.equal(bind2.campaignId, cidB);

// 11) 新团：trpg_world op=new 清零且换 id
v = await run('s1', 'trpg_world', { op: 'new', world: { name: 'C城', genre: '赛博朋克' } });
assert.notEqual(v.__trpg.campaign.id, cidA);
assert.notEqual(v.__trpg.campaign.id, cidB);
assert.equal(v.__trpg.world.name, 'C城');
assert.equal(v.__trpg.pc.name, '', '新团不应带旧角色');

// 11.1) 旧版存档（无 campaignId）按团名接回已有团，不新建重复团
const oldSaveName = 'legacy__old__20260101-000000.json';
await fs.writeFile(
  path.join(savesDir, oldSaveName),
  JSON.stringify({
    format: 'dsh-trpg-save',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    slot: 'old',
    campaign: '旧团',
    state: { campaign: { name: '旧团', system: '旧系统' }, world: { name: '旧团' }, pc: { name: '旧角色-存档版' }, rolls: [] },
  }),
  'utf8',
);
v = await run('s2', 'trpg_load', { file: oldSaveName });
const legacyIds = [];
for (const f of await fs.readdir(campaignsDir)) {
  if (!f.endsWith('.json')) continue;
  const raw = JSON.parse(await fs.readFile(path.join(campaignsDir, f), 'utf8'));
  const st = raw.state ?? raw;
  if ((st.campaign?.name || '') === '旧团') legacyIds.push(st.campaign.id || f.replace(/\.json$/, ''));
}
assert.equal(legacyIds.length, 1, '旧团只应存在一个团文件');
assert.equal(v.__trpg.campaign.id, legacyIds[0], '旧存档应按团名接回旧团');
assert.equal(v.__trpg.pc.name, '旧角色-存档版');
assert.equal(
  v.__trpg.library.campaigns.filter((c) => c.name === '旧团').length,
  1,
  '面板索引里旧团也只有一条',
);

// 12) 非法输入
await assert.rejects(() => run('s1', 'trpg_campaigns', { op: 'open', name: '不存在的团' }), /找不到团/);
await assert.rejects(() => run('s1', 'trpg_load', { slot: 'no-such-slot' }), /.+/);

await fs.rm(cwd, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, tools: tools.length, campaigns: 3, savesDirOk: true }));
