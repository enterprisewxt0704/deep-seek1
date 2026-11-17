/**
 * 开局流程化纯函数自测：20 问问卷 / 购点 / 随机属性 / 人物卡 / 地点预算。
 * 不依赖 Harness，直接 import lib/setup.js。
 */
import assert from 'node:assert/strict';

const S = await import('../../plugin/dsh-trpg-mode/lib/setup.js');

// 1. 问卷完整性：5 组 × 4 题 = 20 题，默认值必须在选项中
assert.equal(S.allQuestions().length, 20);
assert.equal(S.SETUP_GROUPS.length, 5);
assert.deepEqual(
  S.allQuestions().map((q) => q.id),
  Array.from({ length: 20 }, (_, i) => 'q' + (i + 1)),
);
for (const g of S.SETUP_GROUPS) assert.equal(g.questions.length, 4, `${g.id} 应为 4 题`);
for (const q of S.allQuestions()) {
  assert.ok(q.options.includes(q.default), `${q.id} 默认值必须在选项中`);
  assert.ok(q.options.length >= 2 && q.options.length <= 8, `${q.id} 选项数应为 2–8`);
  assert.equal(typeof q.question, 'string');
}

// 2. 默认态与快速填写
const setup = S.defaultSetup();
assert.equal(setup.stage, 'none');
assert.equal(S.answeredCount(setup), 0);
assert.equal(S.missingQuestions(setup).length, 20);
const filled = S.fillDefaults(setup);
assert.equal(S.answeredCount(filled), 20);
assert.equal(S.missingQuestions(filled).length, 0);
const tpl = S.resolveTemplate(filled);
assert.ok(S.POINT_BUY_TEMPLATES[tpl], `resolveTemplate 应返回已知模板，实际 ${tpl}`);

// 3. 购点校验：d20 六属性全 10 合法；全 15 超预算；全 7 低于下限
const d20 = S.POINT_BUY_TEMPLATES.d20;
const all = (v) => Object.fromEntries(d20.attributes.map((a) => [a, v]));
const ok = S.validatePointBuy('d20', all(10));
assert.equal(ok.valid, true, `全 10 应合法：${ok.errors.join('；')}`);
assert.ok(ok.remaining > 0);
assert.equal(S.validatePointBuy('d20', all(15)).valid, false);
assert.equal(S.validatePointBuy('d20', all(7)).valid, false);
assert.equal(S.attributeCost('d20', 8).cost, 0);
assert.ok(S.attributeCost('d20', 15).cost > S.attributeCost('d20', 14).cost);
assert.equal(S.attributeCost('d20', 99).ok, false);

// 4. 随机属性：d20 = 6 组 4d6 去最低，骰面记录完整
const rollD20 = S.rollAttributeSet('d20', () => 0.999);
assert.equal(Object.keys(rollD20.attrs).length, 6);
assert.equal(rollD20.rolls.length, 6);
for (const r of rollD20.rolls) assert.equal(r.dice.length, 4);
for (const v of Object.values(rollD20.attrs)) assert.equal(v, 18);
const roll2d6 = S.rollAttributeSet('2d6', () => 0.5);
assert.equal(Object.keys(roll2d6.attrs).length, 5);
for (const v of Object.values(roll2d6.attrs)) assert.ok(v >= -1 && v <= 3, `2d6 映射越界：${v}`);
const rollNarr = S.rollAttributeSet('narrative', () => 0.5);
assert.equal(rollNarr.rolls.length, 0);
assert.ok(Array.isArray(rollNarr.traits) && rollNarr.traits.length >= 1 && rollNarr.traits.length <= 3);

// 5. 人物卡校验
const card = (name, v) => ({ name, race: '人类', class: '侦探', attributes: all(v) });
assert.equal(S.validateCards([card('甲', 10), card('乙', 10), card('丙', 10)], 'd20').length, 0);
assert.ok(S.validateCards([card('甲', 10), card('乙', 10)], 'd20').length > 0);
assert.ok(S.validateCards([card('', 10), card('乙', 10), card('丙', 10)], 'd20').length > 0);

// 6. 地点购点：区域必选 1×2 点，其余每项 1 点、最多 2 个
const pool = [
  { id: 'r1', name: '旧港', kind: 'region' },
  { id: 'r2', name: '新城', kind: 'region' },
  { id: 'l1', name: '钟楼', kind: 'landmark' },
  { id: 'l2', name: '市场', kind: 'landmark' },
  { id: 'l3', name: '码头', kind: 'landmark' },
  { id: 'f1', name: '公会', kind: 'faction' },
  { id: 'm1', name: '雾', kind: 'mood' },
];
assert.equal(S.locationBudget(), 6);
const p1 = S.validatePlacement(['r1', 'l1'], pool);
assert.equal(p1.valid, true, `区域+地标应合法：${p1.errors.join('；')}`);
assert.equal(p1.cost, 3);
assert.equal(S.validatePlacement(['l1'], pool).valid, false);
assert.equal(S.validatePlacement(['r1', 'l1', 'l2', 'l3'], pool).valid, false);
assert.equal(S.validatePlacement(['r1', 'r2'], pool).valid, false);
assert.equal(S.validatePlacement(['r1', 'l1', 'f1', 'm1'], pool).valid, true);

// 7. 地点随机：必有且仅有 1 个区域，其它每类 ≤2
const rolled = S.rollPlacement(pool, () => 0.1);
assert.equal(rolled.selected.filter((x) => x.kind === 'region').length, 1);
assert.equal(rolled.rolls.length, 4);
for (const kind of ['landmark', 'faction', 'mood']) {
  assert.ok(rolled.selected.filter((x) => x.kind === kind).length <= 2, `${kind} 超过 2 个`);
}
assert.ok(S.describePlacement(rolled.selected).includes('旧港'));

// 8. 阶段提示齐全
for (const stage of S.SETUP_STAGES) {
  const hint = S.nextHint({ ...S.defaultSetup(), stage });
  assert.equal(typeof hint, 'string');
  assert.ok(hint.length > 0, `${stage} 缺少下一步提示`);
  assert.ok(S.STAGE_LABELS[stage], `${stage} 缺少标签`);
}

console.log(JSON.stringify({ ok: true, questions: S.allQuestions().length, template: tpl, placementCost: p1.cost }));
