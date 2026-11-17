/**
 * 跑团模式「开局流程」的纯逻辑：20 问问卷、阶段机、购点模板、掷骰、地点生成。
 * 该文件不依赖 Harness 运行时，可被 Host 半边与离线测试直接使用。
 */

export const SETUP_STAGES = [
  'none',
  'world_q',
  'world_ready',
  'pc_method',
  'pc_build',
  'pc_pick',
  'place_method',
  'place_done',
  'ready',
];

export const STAGE_LABELS = {
  none: '未开始',
  world_q: '世界观问卷',
  world_ready: '世界观已生成',
  pc_method: '选择角色来源',
  pc_build: '创建角色',
  pc_pick: '挑选人物卡',
  place_method: '选择开始地点方式',
  place_done: '开始地点已生成',
  ready: '可以开始游戏',
};

export function defaultSetup() {
  return {
    stage: 'none',
    startedAt: null,
    answers: [],
    groupsDone: [],
    worldDraft: null,
    pcMethod: '',
    pcMode: '',
    pointBuy: { template: 'd20', alloc: {}, spent: 0 },
    pcRolls: [],
    pcCards: [],
    placeMethod: '',
    placeDraft: null,
    placeRolls: [],
    skipped: [],
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const arr = (v) => (Array.isArray(v) ? v : []);

export function normalizeSetup(raw) {
  const base = defaultSetup();
  const s = { ...base, ...(isObj(raw) ? raw : {}) };
  s.stage = SETUP_STAGES.includes(s.stage) ? s.stage : 'none';
  s.startedAt = s.startedAt ?? null;
  s.answers = arr(s.answers)
    .filter((a) => isObj(a) && typeof a.id === 'string')
    .map((a) => ({
      id: str(a.id),
      question: str(a.question),
      answer: str(a.answer),
      source: ['option', 'custom', 'default'].includes(a.source) ? a.source : 'custom',
    }))
    .slice(0, 40);
  s.groupsDone = arr(s.groupsDone).filter((g) => typeof g === 'string').slice(0, 10);
  s.worldDraft = isObj(s.worldDraft) ? s.worldDraft : null;
  s.pcMethod = ['pointbuy', 'roll', 'cards'].includes(s.pcMethod) ? s.pcMethod : '';
  s.pcMode = ['self', 'cards'].includes(s.pcMode) ? s.pcMode : '';
  s.pointBuy = {
    ...base.pointBuy,
    ...(isObj(s.pointBuy) ? s.pointBuy : {}),
  };
  s.pointBuy.template = POINT_BUY_TEMPLATES[s.pointBuy.template] ? s.pointBuy.template : 'd20';
  s.pointBuy.alloc = isObj(s.pointBuy.alloc) ? s.pointBuy.alloc : {};
  s.pointBuy.spent = Number.isFinite(Number(s.pointBuy.spent)) ? Number(s.pointBuy.spent) : 0;
  s.pcRolls = arr(s.pcRolls).filter(isObj).slice(0, 20);
  s.pcCards = arr(s.pcCards)
    .filter((c) => isObj(c) && typeof c.id === 'string')
    .slice(0, 6)
    .map((c) => ({ ...c, id: str(c.id) }));
  s.placeMethod = ['pointbuy', 'roll'].includes(s.placeMethod) ? s.placeMethod : '';
  s.placeDraft = isObj(s.placeDraft) ? s.placeDraft : null;
  s.placeRolls = arr(s.placeRolls).filter(isObj).slice(0, 20);
  s.skipped = arr(s.skipped).filter((x) => typeof x === 'string').slice(0, 10);
  return s;
}

/* ------------------------------------------------------------------ */
/* 20 问问卷                                                           */
/* ------------------------------------------------------------------ */

export const SETUP_GROUPS = [
  {
    id: 'g1',
    title: '世界底色',
    questions: [
      {
        id: 'q1',
        question: '题材与时代',
        hint: '决定世界的第一印象',
        options: ['中世纪奇幻', '蒸汽朋克', '现代都市神秘', '太空歌剧', '末日废土'],
        default: '中世纪奇幻',
      },
      {
        id: 'q2',
        question: '地理尺度',
        hint: '故事主要发生在多大范围',
        options: ['一座城市', '一个区域', '一整块大陆', '多个世界'],
        default: '一座城市',
      },
      {
        id: 'q3',
        question: '超自然与科技水平',
        hint: '魔法/异能是否存在，科技到什么程度',
        options: ['无超自然·前工业', '低魔·工业', '高魔·前工业', '无超自然·现代', '异能·未来'],
        default: '低魔·工业',
      },
      {
        id: 'q4',
        question: '社会结构与权力',
        hint: '谁在统治，冲突从哪里来',
        options: ['王权与贵族', '教会与信仰', '财阀与行会', '军阀与暴力', '无政府混乱', '多种势力并存'],
        default: '多种势力并存',
      },
    ],
  },
  {
    id: 'g2',
    title: '世界细节',
    questions: [
      {
        id: 'q5',
        question: '经济与货币',
        hint: '影响物价、报酬与交易',
        options: ['以物易物', '金属货币', '纸币与银行', '信用点/电子货币'],
        default: '金属货币',
      },
      {
        id: 'q6',
        question: '语言与文化',
        hint: '是否存在沟通障碍与文化冲突',
        options: ['单一通用语', '多语言并存', '古语失传', '文化冲突激烈'],
        default: '单一通用语',
      },
      {
        id: 'q7',
        question: '种族与族群',
        hint: '玩家可选的种族范围与族群关系',
        options: ['人类为主', '多种族共存', '种族隔离', '非人主导'],
        default: '人类为主',
      },
      {
        id: 'q8',
        question: '宗教与信仰',
        hint: '信仰如何影响世界与 NPC',
        options: ['多神信仰', '一神信仰', '无神论', '邪教横行', '信仰即力量'],
        default: '多神信仰',
      },
    ],
  },
  {
    id: 'g3',
    title: '基调与边界',
    questions: [
      {
        id: 'q9',
        question: '整体基调',
        hint: '故事的情绪底色',
        options: ['热血冒险', '黑暗悬疑', '轻松日常', '残酷生存', '悲喜剧'],
        default: '黑暗悬疑',
      },
      {
        id: 'q10',
        question: '叙事节奏',
        hint: '每回合推进的密度',
        options: ['快节奏动作', '调查推理', '经营养成', '慢热史诗'],
        default: '调查推理',
      },
      {
        id: 'q11',
        question: '内容边界与禁忌',
        hint: '血腥/恐怖/浪漫的尺度，以及绝对禁止的内容',
        options: ['全年龄向', '适度黑暗', '成人向（不含极端内容）', '自定义'],
        default: '适度黑暗',
      },
      {
        id: 'q12',
        question: '玩家角色定位',
        hint: '你在故事中的位置',
        options: ['独行侠', '小队一员', '领袖', '被卷入的普通人'],
        default: '独行侠',
      },
    ],
  },
  {
    id: 'g4',
    title: '规则与挑战',
    questions: [
      {
        id: 'q13',
        question: '规则系统',
        hint: '决定车卡与判定的模板',
        options: ['轻规则叙事', '中度 d20', '详细模拟', '完全自定义'],
        default: '中度 d20',
      },
      {
        id: 'q14',
        question: '核心判定方式',
        hint: '掷什么骰、怎么判定成功',
        options: ['d20+加值', '2d6+加值', '百分比 d100', '纯叙事无骰'],
        default: 'd20+加值',
      },
      {
        id: 'q15',
        question: '难度与死亡率',
        hint: '失败与死亡的代价',
        options: ['英雄不死', '有代价的失败', '残酷高死亡'],
        default: '有代价的失败',
      },
      {
        id: 'q16',
        question: '成长与资源',
        hint: '升级速度与物资稀缺程度',
        options: ['快速成长', '缓慢成长', '资源稀缺', '经营向'],
        default: '缓慢成长',
      },
    ],
  },
  {
    id: 'g5',
    title: '开局与玩法',
    questions: [
      {
        id: 'q17',
        question: '核心冲突',
        hint: '主线矛盾的来源',
        options: ['战争', '谜团', '生存', '政治阴谋', '探索未知'],
        default: '谜团',
      },
      {
        id: 'q18',
        question: '开局钩子',
        hint: '第一幕如何把你卷入',
        options: ['一份委托', '一场灾难', '一次巧合', '失忆醒来', '自定义'],
        default: '一份委托',
      },
      {
        id: 'q19',
        question: '开始地区域类型',
        hint: '故事从哪种地方开始',
        options: ['城市', '边境', '荒野', '特殊地点（浮空岛/海底城等）'],
        default: '城市',
      },
      {
        id: 'q20',
        question: '桌面细节',
        hint: '单回合时间跨度、骰子偏好、是否有同伴、语言风格',
        options: ['10 分钟/回合·默认骰·无同伴', '30 分钟/回合·默认骰·无同伴', '1 小时/回合·默认骰·有同伴', '自定义'],
        default: '30 分钟/回合·默认骰·无同伴',
      },
    ],
  },
];

export function allQuestions() {
  return SETUP_GROUPS.flatMap((g) => g.questions.map((q) => ({ ...q, group: g.id, groupTitle: g.title })));
}

export function questionsForGroup(group) {
  const g = SETUP_GROUPS.find((x) => x.id === group);
  return g ? g.questions.map((q) => ({ ...q, group: g.id, groupTitle: g.title })) : [];
}

export function answerMap(setup) {
  const map = {};
  for (const a of setup?.answers || []) map[a.id] = a.answer;
  return map;
}

export function answeredCount(setup) {
  const ids = new Set((setup?.answers || []).map((a) => a.id));
  return allQuestions().filter((q) => ids.has(q.id)).length;
}

export function missingQuestions(setup) {
  const ids = new Set((setup?.answers || []).map((a) => a.id));
  return allQuestions().filter((q) => !ids.has(q.id));
}

/** 用默认答案填满未答的问题（玩家选择「快速开局」）。 */
export function fillDefaults(setup) {
  const next = normalizeSetup(setup);
  const have = new Set(next.answers.map((a) => a.id));
  for (const q of allQuestions()) {
    if (!have.has(q.id)) {
      next.answers.push({ id: q.id, question: q.question, answer: q.default, source: 'default' });
    }
  }
  for (const g of SETUP_GROUPS) {
    if (!next.groupsDone.includes(g.id)) next.groupsDone.push(g.id);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 购点模板                                                            */
/* ------------------------------------------------------------------ */

export const POINT_BUY_TEMPLATES = {
  d20: {
    id: 'd20',
    name: 'd20（27 点 / 8–15）',
    attributes: ['力量', '敏捷', '体质', '智力', '感知', '魅力'],
    base: 8,
    min: 8,
    max: 15,
    budget: 27,
    costOf: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 },
  },
  '2d6': {
    id: '2d6',
    name: '2d6（6 点 / -1…+3）',
    attributes: ['力量', '敏捷', '心性', '智力', '魅力'],
    base: 0,
    min: -1,
    max: 3,
    budget: 6,
    costOf: { '-1': 0, 0: 0, 1: 1, 2: 2, 3: 3 },
  },
  percentile: {
    id: 'percentile',
    name: '百分比（240 点 / 20–80）',
    attributes: ['力量', '敏捷', '体质', '智力', '感知', '魅力'],
    base: 40,
    min: 20,
    max: 80,
    budget: 240,
    costOf: null,
  },
  narrative: {
    id: 'narrative',
    name: '叙事（不点数）',
    attributes: [],
    base: 0,
    min: 0,
    max: 0,
    budget: 0,
    costOf: null,
  },
};

/** 根据世界观答案挑选购点模板：默认 d20。 */
export function resolveTemplate(setup) {
  const answers = answerMap(setup);
  const judge = str(answers.q14);
  const system = str(answers.q13);
  if (judge.includes('2d6')) return '2d6';
  if (judge.includes('百分比') || judge.includes('d100')) return 'percentile';
  if (judge.includes('叙事') || system.includes('轻规则') || system.includes('叙事')) return 'narrative';
  return 'd20';
}

export function attributeCost(template, value) {
  const t = POINT_BUY_TEMPLATES[template] || POINT_BUY_TEMPLATES.d20;
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return { ok: false, reason: '不是数字' };
  if (v < t.min || v > t.max) return { ok: false, reason: `需在 ${t.min}–${t.max} 之间` };
  if (t.id === '2d6' || t.id === 'narrative') {
    if (t.id === 'narrative') return { ok: true, cost: 0 };
    return { ok: true, cost: Math.max(0, v) };
  }
  if (t.id === 'percentile') return { ok: true, cost: Math.max(0, v - t.base) };
  const cost = t.costOf?.[v];
  return cost === undefined ? { ok: false, reason: '不在花费表内' } : { ok: true, cost };
}

/** 校验购点分配；返回 {valid, spent, remaining, attrs, errors}。 */
export function validatePointBuy(template, alloc) {
  const t = POINT_BUY_TEMPLATES[template] || POINT_BUY_TEMPLATES.d20;
  const errors = [];
  const attrs = {};
  if (t.id === 'narrative') return { valid: true, spent: 0, remaining: 0, attrs: {}, errors: [] };
  for (const key of t.attributes) {
    if (alloc && alloc[key] !== undefined) {
      const r = attributeCost(t.id, alloc[key]);
      if (!r.ok) errors.push(`${key}：${r.reason}`);
      else attrs[key] = Math.round(Number(alloc[key]));
    } else {
      errors.push(`${key}：未分配`);
    }
  }
  // 不允许未知属性
  if (alloc) {
    for (const key of Object.keys(alloc)) {
      if (!t.attributes.includes(key)) errors.push(`未知属性「${key}」`);
    }
  }
  let spent = 0;
  for (const key of t.attributes) {
    if (attrs[key] === undefined) continue;
    const r = attributeCost(t.id, attrs[key]);
    if (r.ok) spent += r.cost;
  }
  const remaining = t.budget - spent;
  if (remaining < 0) errors.push(`超出预算 ${Math.abs(remaining)} 点`);
  return { valid: errors.length === 0 && remaining >= 0, spent, remaining, attrs, errors, template: t.id };
}

/* ------------------------------------------------------------------ */
/* 掷骰生成属性                                                        */
/* ------------------------------------------------------------------ */

export function d4d6DropLowest(rng = Math.random) {
  const dice = Array.from({ length: 4 }, () => 1 + Math.floor(rng() * 6));
  const sorted = [...dice].sort((a, b) => a - b);
  const kept = sorted.slice(1);
  return { dice, total: kept.reduce((a, b) => a + b, 0) };
}

const MAP_2D6 = { 2: -1, 3: -1, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1, 9: 2, 10: 2, 11: 3, 12: 3 };

/** 按模板掷出一组属性；返回 {attrs, rolls}。 */
export function rollAttributeSet(template, rng = Math.random) {
  const t = POINT_BUY_TEMPLATES[template] || POINT_BUY_TEMPLATES.d20;
  const attrs = {};
  const rolls = [];
  if (t.id === 'narrative') {
    const traits = ['沉稳', '敏锐', '直觉强', '擅长交涉', '意志坚定', '身手利落'];
    const picked = traits.filter(() => rng() < 0.4).slice(0, 3);
    while (picked.length < 3) picked.push(traits[Math.floor(rng() * traits.length)]);
    return { attrs: {}, rolls: [], traits: [...new Set(picked)] };
  }
  for (const key of t.attributes) {
    if (t.id === '2d6') {
      const dice = [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)];
      const total = dice[0] + dice[1];
      const value = MAP_2D6[total] ?? 0;
      attrs[key] = value;
      rolls.push({ id: key, dice, total: value, rawTotal: total });
    } else if (t.id === 'percentile') {
      const value = 1 + Math.floor(rng() * 100);
      attrs[key] = value;
      rolls.push({ id: key, dice: [value], total: value });
    } else {
      const r = d4d6DropLowest(rng);
      attrs[key] = r.total;
      rolls.push({ id: key, dice: r.dice, total: r.total });
    }
  }
  return { attrs, rolls };
}

/* ------------------------------------------------------------------ */
/* 主持人人物卡校验                                                    */
/* ------------------------------------------------------------------ */

export function validateCards(cards, template) {
  const issues = [];
  const list = arr(cards);
  if (list.length !== 3) issues.push('需要正好 3 张人物卡');
  list.forEach((card, i) => {
    if (!isObj(card)) {
      issues.push(`第 ${i + 1} 张不是对象`);
      return;
    }
    if (!card.name) issues.push(`第 ${i + 1} 张缺少姓名`);
    if (!isObj(card.attributes)) issues.push(`第 ${i + 1} 张（${card.name || '?'}）缺少属性`);
    else {
      const check = validatePointBuy(template, card.attributes);
      if (!check.valid && check.errors.some((e) => e.includes('超出预算') || e.includes('需在'))) {
        issues.push(`第 ${i + 1} 张（${card.name || '?'}）属性不合购点规则：${check.errors.join('；')}`);
      }
    }
  });
  return issues;
}

/* ------------------------------------------------------------------ */
/* 开始地点                                                            */
/* ------------------------------------------------------------------ */

export const LOCATION_KINDS = ['region', 'landmark', 'faction', 'mood'];
export const LOCATION_KIND_LABELS = {
  region: '区域类型',
  landmark: '地标',
  faction: '势力',
  mood: '氛围/事件',
};

export function locationBudget() {
  return 6;
}

export function normalizePool(pool) {
  return arr(pool)
    .filter((x) => isObj(x) && (x.name || x.id))
    .map((x, i) => ({
      id: str(x.id) || `loc-${i + 1}`,
      name: str(x.name) || str(x.id),
      kind: LOCATION_KINDS.includes(x.kind) ? x.kind : 'landmark',
      tag: str(x.tag),
    }))
    .slice(0, 40);
}

/** 校验地点购点：region 必选 1（2 点），其余每项 1 点、最多 2 个。 */
export function validatePlacement(picks, pool) {
  const entries = normalizePool(pool);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const selected = arr(picks)
    .map((id) => byId.get(String(id)))
    .filter(Boolean);
  const errors = [];
  if (arr(picks).length !== selected.length) errors.push('包含未知的地点候选 id');
  const count = (kind) => selected.filter((e) => e.kind === kind).length;
  if (count('region') !== 1) errors.push('区域类型必须且只能选 1 项');
  for (const kind of ['landmark', 'faction', 'mood']) {
    if (count(kind) > 2) errors.push(`${LOCATION_KIND_LABELS[kind]}最多选 2 项`);
  }
  const cost = count('region') * 2 + count('landmark') + count('faction') + count('mood');
  const budget = locationBudget();
  if (cost > budget) errors.push(`超出预算：已用 ${cost} 点，预算 ${budget} 点`);
  return {
    valid: errors.length === 0,
    selected,
    cost,
    remaining: budget - cost,
    errors,
  };
}

export function describePlacement(selected) {
  const by = (kind) => selected.filter((e) => e.kind === kind).map((e) => e.name);
  const region = by('region')[0] || '未知区域';
  const landmarks = by('landmark');
  const factions = by('faction');
  const moods = by('mood');
  const parts = [`开始地点：${region}`];
  if (landmarks.length) parts.push(`地标：${landmarks.join('、')}`);
  if (factions.length) parts.push(`势力：${factions.join('、')}`);
  if (moods.length) parts.push(`氛围/事件：${moods.join('、')}`);
  return parts.join('；');
}

/** 随机地点：区域 1 + 地标 1 + 势力 1 + 氛围 1（池子不足时跳过）。 */
export function rollPlacement(pool, rng = Math.random) {
  const entries = normalizePool(pool);
  const pickOne = (kind, count) => {
    const list = entries.filter((e) => e.kind === kind);
    const picked = [];
    for (let i = 0; i < count && list.length > 0; i += 1) {
      const idx = Math.floor(rng() * list.length);
      picked.push(list[idx]);
      list.splice(idx, 1);
    }
    return picked;
  };
  const regions = pickOne('region', 1);
  const landmarks = pickOne('landmark', 1);
  const factions = pickOne('faction', 1);
  const moods = pickOne('mood', 1);
  const rolls = [];
  for (const group of [regions, landmarks, factions, moods]) {
    for (const e of group) rolls.push({ id: e.kind, dice: [e.id], total: e.name });
  }
  return { selected: [...regions, ...landmarks, ...factions, ...moods], rolls };
}

/** 阶段提示：给模型与面板看的「下一步」。 */
export function nextHint(setup) {
  const s = normalizeSetup(setup);
  const answered = answeredCount(s);
  switch (s.stage) {
    case 'none':
      return '尚未开始：调用 trpg_setup op=start 进入 20 问世界观问卷。';
    case 'world_q':
      return answered < 20
        ? `世界观问卷进行中：已答 ${answered}/20，还差 ${20 - answered} 题（每批 4 题，用 ask_user_question）。`
        : '20 问已答完：生成世界观草案请玩家确认，然后 trpg_setup op=world 写入。';
    case 'world_ready':
      return '世界观已就绪：询问角色来源（自建购点 / 自建随机 / 主持人人物卡）。';
    case 'pc_method':
      return '已选择角色来源：按对应方式创建角色。';
    case 'pc_build':
      return s.pcMethod === 'pointbuy'
        ? '购点中：让玩家分配属性，用 trpg_setup op=pc_pointbuy 反复校验，完成后 op=pc_finalize。'
        : '随机生成中：用 op=pc_roll 掷属性，展示结果后 op=pc_finalize。';
    case 'pc_pick':
      return '人物卡已给出：请玩家选择一张（op=pc_pick），然后 op=pc_finalize。';
    case 'place_method':
      return '角色就绪：询问开始地点方式（购点 / 随机）。';
    case 'place_done':
      return '地点已生成：op=place_finalize 写入场景并开始第一幕。';
    case 'ready':
      return '开局流程已完成，可以开始游戏。';
    default:
      return '继续当前步骤。';
  }
}
