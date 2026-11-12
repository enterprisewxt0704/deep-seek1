import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = await import('../plugin/dsh-trpg-mode/lib/state.js');
const saves = await import('../plugin/dsh-trpg-mode/lib/saves.js');

const s = state.defaultState();
assert.ok(s.campaign && s.world && s.pc && s.scene && Array.isArray(s.rolls));
assert.equal(state.formatClock(0), '第1天 08:00');
assert.equal(state.formatClock(95), '第1天 09:35');
assert.equal(state.slugify('灰钟港 Greybell / 第一章'), '灰钟港-greybell-第一章');

// 加权骰：weights [1,1,1,2,2,3] 总和 10 => 面 1-3 各 10%、面 4/5 各 20%、面 6 为 30%
const counts = {};
for (let i = 0; i < 20000; i += 1) {
  const r = state.rollOne(6, [1, 1, 1, 2, 2, 3]);
  counts[r.value] = (counts[r.value] ?? 0) + 1;
}
assert.equal(Object.keys(counts).length, 6);
assert.ok(counts[1] > 1700 && counts[1] < 2300, `counts=${JSON.stringify(counts)}`);
assert.ok(counts[4] > 3700 && counts[4] < 4300, `counts=${JSON.stringify(counts)}`);
assert.ok(counts[6] > 5600 && counts[6] < 6400, `counts=${JSON.stringify(counts)}`);

// outcome 规则（target = {type:'ge'|'le', value:N}）
assert.equal(state.resolveOutcome([{ sides: 20, value: 20 }], 20, { type: 'ge', value: 15 }), 'critical');
assert.equal(state.resolveOutcome([{ sides: 20, value: 1 }], 1, { type: 'ge', value: 15 }), 'critical-fail');
assert.equal(state.resolveOutcome([{ sides: 20, value: 12 }], 12, { type: 'ge', value: 10 }), 'success');
assert.equal(state.resolveOutcome([{ sides: 20, value: 3 }], 3, { type: 'ge', value: 10 }), 'fail');
assert.equal(state.resolveOutcome([{ sides: 100, value: 4 }], 4, { type: 'le', value: 50 }), 'critical');
assert.equal(state.resolveOutcome([{ sides: 6, value: 2 }], 2, null), 'none');

// normalize 后 campaign 兜底
const raw = state.defaultState();
raw.world.name = '灰钟港';
raw.world.genre = '蒸汽朋克';
const n = state.normalizeState(raw);
assert.equal(n.campaign.name, '灰钟港');
assert.equal(n.campaign.system, '蒸汽朋克');

// 存档写入/列出/读取
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'trpg-selftest-'));
const written = await saves.writeSave(tmp, n, { slot: 't1', note: 'selftest' });
assert.ok(written.file && written.file.endsWith('.json'));
const listed = await saves.listSaves(tmp);
assert.equal(listed.length >= 1, true);
const back = await saves.readSave(tmp, { latest: true });
assert.equal(back.state.world.name, '灰钟港');
const latest = JSON.parse(await fs.readFile(path.join(tmp, '.trpg', 'saves', 'latest.json'), 'utf8'));
assert.equal(latest.format, 'dsh-trpg-save');
await fs.rm(tmp, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, counts, written: written.file, listed: listed.length, latestFormat: latest.format }));
