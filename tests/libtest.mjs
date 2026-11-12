import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLibrarySync,
  writeCheckpoint,
  writeSave,
  freshCampaign,
} from '../plugin/dsh-trpg-mode/lib/saves.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-lib-'));
const a = freshCampaign('甲团');
a.world.name = '甲团';
a.world.genre = '奇幻';
a.pc.name = '甲角色';
await writeCheckpoint(cwd, a);
await writeSave(cwd, a, { slot: 's1', note: '测试' });
const b = freshCampaign('乙团');
b.world.name = '乙团';
b.world.genre = '科幻';
await writeCheckpoint(cwd, b);

const lib = buildLibrarySync(cwd, a);
console.log(JSON.stringify({
  campaigns: lib.campaigns.map((c) => ({ id: c.id, name: c.name, saves: c.saveCount, pc: c.pcName })),
  saves: lib.saves.map((s) => ({ campaign: s.campaign, slot: s.slot })),
  active: lib.activeCampaignId,
}, null, 2));
if (lib.campaigns.length !== 2) throw new Error('campaign count');
if (lib.saves.length !== 1) throw new Error('save count');
if (lib.activeCampaignId !== a.campaign.id) throw new Error('active id');
for (const f of lib.saves) {
  if (!String(f.file).includes('campaigns')) { /* file 在 saves 目录 */ }
}
fs.rmSync(cwd, { recursive: true, force: true });
console.log('libtest ok');
