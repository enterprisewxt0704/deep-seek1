import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProjectionDefinition } from '../../plugin/dsh-trpg-mode/index.js';
import { buildLibrarySync, freshCampaign, writeCheckpoint, writeSave } from '../../plugin/dsh-trpg-mode/lib/saves.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-proj-'));

// 模拟：工作区里已经有两个团 + 一条存档（新会话建立时应当全部出现在面板索引里）
const a = freshCampaign('甲团');
a.world.name = '甲团';
a.world.genre = '奇幻';
a.pc.name = '甲角色';
await writeCheckpoint(cwd, a);
await writeSave(cwd, a, { slot: 's1' });
const b = freshCampaign('乙团');
b.world.name = '乙团';
b.world.genre = '科幻';
await writeCheckpoint(cwd, b);

const def = buildProjectionDefinition();
const state = def.init({ cwd });
const campaigns = state.library?.campaigns || [];
const saves = state.library?.saves || [];
console.log(JSON.stringify({
  key: def.key,
  stateVersion: def.stateVersion,
  campaignName: state.campaign.name,
  campaigns: campaigns.map((c) => `${c.name}/${c.pcName || '-'}/${c.saveCount || 0}`),
  saves: saves.map((s) => `${s.campaign}:${s.slot}`),
}, null, 2));

if (campaigns.length !== 2) throw new Error('expect 2 campaigns');
if (saves.length !== 1) throw new Error('expect 1 save');
if (state.campaign.id) throw new Error('fresh state must not auto-attach a campaign');
const folded = def.apply(state, {
  type: 'tool/result',
  data: { meta: { trpg: { campaign: { id: a.campaign.id, name: '甲团' }, world: { name: '甲团' } } } },
});
if (folded.campaign.id !== a.campaign.id) throw new Error('meta fold');
const untouched = def.apply(state, { type: 'assistant/message', data: {} });
if (untouched !== state) throw new Error('must return same ref for unrelated events');
fs.rmSync(cwd, { recursive: true, force: true });
console.log('projtest ok');
