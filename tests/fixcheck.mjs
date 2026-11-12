/**
 * 修复回归测试（v1.2.1）：
 *   1) 旧 state.json 在第一次工具调用前必须已迁移（投影 init 同步迁移路径）
 *   2) 旧存档没有 campaignId 时按团名归到团上
 *   3) trpg_campaigns op=list 在「有团 / 无团」两种情况下都不报错
 *   4) op=open 支持按团名包含匹配
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'trpg-fix-'));
const root = path.join(cwd, '.trpg');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(
  path.join(root, 'state.json'),
  JSON.stringify({
    format: 'dsh-trpg-save',
    version: 2,
    state: {
      campaign: { name: '灰钟港（Greybell Harbor）', system: '蒸汽朋克' },
      world: { name: '灰钟港（Greybell Harbor）', genre: '蒸汽朋克' },
      pc: { name: '伊莱亚斯·维尔' },
      scene: { title: '雾夜·钟楼码头' },
      rolls: [{ sides: 20, value: 12, total: 18, label: '侦查', outcome: 'success' }],
    },
  }),
  'utf8',
);
await fs.mkdir(path.join(root, 'saves'), { recursive: true });
await fs.writeFile(
  path.join(root, 'saves', 'trpg__legacy__manual__20260101-000000.json'),
  JSON.stringify({
    format: 'dsh-trpg-save',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    slot: 'manual',
    note: '旧档',
    campaignId: '',
    campaign: '灰钟港（Greybell Harbor）',
    state: {
      campaign: { name: '灰钟港（Greybell Harbor）' },
      world: { name: '灰钟港（Greybell Harbor）' },
      pc: { name: '伊莱亚斯·维尔' },
    },
  }),
  'utf8',
);

const { buildLibrarySync, migrateLegacyStateSync } = await import('../plugin/dsh-trpg-mode/lib/saves.js');
const { createToolDefinitions } = await import('../plugin/dsh-trpg-mode/lib/tools.js');

// 1) 同步迁移 + 投影播种：第一次打开面板就应该看到旧团
migrateLegacyStateSync(cwd);
const lib0 = buildLibrarySync(cwd, null);
assert.equal(lib0.campaigns.length, 1, `sync migration should yield 1 campaign, got ${JSON.stringify(lib0.campaigns)}`);
assert.equal(lib0.campaigns[0].name, '灰钟港（Greybell Harbor）');
assert.equal(lib0.campaigns[0].saveCount, 1, 'legacy save should attach by campaign name');
assert.equal(lib0.saves.length, 1);
assert.equal(lib0.saves[0].campaignId, lib0.campaigns[0].id, 'save campaignId should be resolved');

// 2) 工具层：列表正常、按名打开、另起新团
const sessions = new Map([['s1', { id: 's1', header: { cwd } }]]);
const ctx = { get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) };
const projected = new Map();
const handle = { stateOf: (session) => (session && projected.get(session.id)) || null };
const tools = createToolDefinitions(ctx, handle);
const byName = new Map(tools.map((t) => [t.name, t]));
const run = async (name, args) => {
  const tool = byName.get(name);
  const value = await tool.execute(args, { agent: { id: 's1' } });
  assert.ok(value && typeof value.text === 'string', `${name} no text`);
  if (value.__trpg) projected.set('s1', value.__trpg);
  return value;
};

let v = await run('trpg_campaigns', { op: 'list' });
assert.ok(v.text.includes('工作区共有 1 个团'), v.text);
assert.ok(v.text.includes('灰钟港'), v.text);
assert.ok(!v.text.includes('lines.join'), v.text);

v = await run('trpg_campaigns', { op: 'open', name: '灰钟港' });
assert.ok(v.text.includes('已切换到团「灰钟港'), v.text);
assert.ok(v.text.includes('伊莱亚斯·维尔'), v.text);

v = await run('trpg_campaigns', { op: 'open', name: '不存在的团' }).catch((e) => e);
assert.ok(v instanceof Error && String(v.message).includes('找不到团'), 'missing campaign should throw');

v = await run('trpg_world', { op: 'new', world: { name: '新团X', genre: '测试' } });
assert.ok(v.text.includes('另起新团'), v.text);

// 3) 空工作区列表不报错
const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'trpg-empty-'));
const sessions2 = new Map([['e1', { id: 'e1', header: { cwd: empty } }]]);
const ctx2 = { get: (name) => (name === 'sessions' ? { get: (id) => sessions2.get(id) } : undefined) };
const tools2 = createToolDefinitions(ctx2, { stateOf: () => null });
const listTool = tools2.find((t) => t.name === 'trpg_campaigns');
const emptyValue = await listTool.execute({ op: 'list' }, { agent: { id: 'e1' } });
assert.ok(emptyValue.text.includes('还没有任何团'), emptyValue.text);

console.log('fixcheck ok', JSON.stringify({ campaigns: lib0.campaigns.length, saves: lib0.saves.length }));
