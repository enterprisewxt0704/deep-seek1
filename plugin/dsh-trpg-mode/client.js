/**
 * 跑团模式客户端半边：右侧栏「跑团」标签页（角色卡 / 骰点 / 团史 / 世界 / 存档）
 * 以及会话头部的「跑团」按钮。数据来自宿主会话投影 `trpg`（wire 值），
 * 因此面板与对话内容始终一致，刷新页面后自动恢复。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-trpg-mode',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var TAB_KIND = 'trpg-sheet';
    var TAB_ID = '@local/dsh-trpg-mode/sheet';
    var PRESETS = { trpg: true, 'trpg-a': true };

    var C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    };

    function openTrpgTab(ctx) {
      try {
        var ctrl = ctx.get ? ctx.get('sidebarRight') : undefined;
        if (ctrl && typeof ctrl.openTab === 'function') {
          ctrl.openTab(TAB_KIND);
          if (typeof ctrl.toggleExpanded === 'function' && typeof ctrl.isExpanded === 'function' && !ctrl.isExpanded()) {
            ctrl.toggleExpanded();
          }
        }
      } catch (error) {
        console.warn('[dsh-trpg-mode] 打开跑团面板失败', error);
      }
    }

    function fmtRoll(roll) {
      if (!roll) return '';
      var dice = Array.isArray(roll.dice) ? roll.dice.map(function (d) { return String(d.value) + (d.weighted ? 'w' : ''); }).join('+') : '';
      var mod = roll.modifier ? (roll.modifier > 0 ? '+' + roll.modifier : String(roll.modifier)) : '';
      var outcome = { critical: '大成功', 'critical-fail': '大失败', success: '成功', fail: '失败' }[roll.outcome] || '—';
      var target = roll.target ? '（' + (roll.target.type === 'le' ? '≤' : '≥') + roll.target.value + '）' : '';
      return (roll.label ? '「' + roll.label + '」' : '掷骰') + ' ' + dice + mod + ' = ' + roll.total + target + ' → ' + outcome;
    }

    function Section(props) {
      return h('div', { style: { marginBottom: 14 } }, [
        h('div', {
          key: 'title',
          style: { fontSize: 11, letterSpacing: '.08em', color: C.faint, marginBottom: 6, textTransform: 'uppercase' },
        }, props.title),
        h('div', { key: 'body' }, props.children),
      ]);
    }

    function Row(props) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '1px 0', fontSize: 12.5 } }, [
        h('span', { key: 'k', style: { color: C.dim } }, props.label),
        h('span', { key: 'v', style: { color: props.color || C.text, fontWeight: 500, textAlign: 'right' } }, props.value),
      ]);
    }

    function PcTab(props) {
      var pc = props.pc || {};
      var attrs = pc.attributes && typeof pc.attributes === 'object' ? Object.keys(pc.attributes) : [];
      var skills = pc.skills && typeof pc.skills === 'object' ? Object.keys(pc.skills) : [];
      return h('div', null, [
        h(Section, { key: 'base', title: '角色' },
          h('div', null, [
            h(Row, { key: 'n', label: '姓名', value: pc.name || '未创建' }),
            h(Row, { key: 'r', label: '种族/职业', value: (pc.race || '—') + ' / ' + (pc.class || '—') }),
            h(Row, { key: 'l', label: '等级', value: 'Lv.' + (pc.level || 1) }),
            h(Row, { key: 'xp', label: '经验', value: String(pc.xp || 0) }),
            h(Row, { key: 'ac', label: '护甲 AC', value: String(pc.ac == null ? '—' : pc.ac) }),
          ]),
        ),
        h(Section, { key: 'hp', title: '状态' },
          h('div', null, [
            h(Row, {
              key: 'hp',
              label: 'HP',
              value: (pc.hp ? pc.hp.cur : '—') + ' / ' + (pc.hp ? pc.hp.max : '—'),
              color: pc.hp && pc.hp.cur <= Math.max(1, pc.hp.max * 0.25) ? C.err : C.ok,
            }),
            h(Row, { key: 'mp', label: 'MP', value: (pc.mp ? pc.mp.cur : 0) + ' / ' + (pc.mp ? pc.mp.max : 0) }),
            h(Row, {
              key: 'c',
              label: '状态',
              value: Array.isArray(pc.conditions) && pc.conditions.length ? pc.conditions.join('、') : '正常',
              color: Array.isArray(pc.conditions) && pc.conditions.length ? C.warn : C.text,
            }),
          ]),
        ),
        attrs.length ? h(Section, { key: 'attrs', title: '属性' },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' } },
            attrs.map(function (k) { return h(Row, { key: k, label: k, value: String(pc.attributes[k]) }); })),
        ) : null,
        skills.length ? h(Section, { key: 'skills', title: '技能' },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' } },
            skills.map(function (k) { return h(Row, { key: k, label: k, value: String(pc.skills[k]) }); })),
        ) : null,
        Array.isArray(pc.inventory) && pc.inventory.length
          ? h(Section, { key: 'inv', title: '物品' },
              h('div', { style: { fontSize: 12.5, color: C.text, lineHeight: 1.6 } },
                pc.inventory.map(function (item, i) {
                  return h('div', { key: i }, '· ' + (typeof item === 'string' ? item : item && item.name ? item.name + (item.qty ? ' ×' + item.qty : '') : JSON.stringify(item)));
                })),
            )
          : null,
        pc.notes ? h(Section, { key: 'notes', title: '备注' },
          h('div', { style: { fontSize: 12.5, color: C.dim, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, pc.notes)) : null,
      ]);
    }

    function DiceTab(props) {
      var rolls = Array.isArray(props.rolls) ? props.rolls.slice(-20).reverse() : [];
      var cfg = props.diceConfig || {};
      var profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
      var time = props.timeConfig || {};
      return h('div', null, [
        h(Section, { key: 'clock', title: '游戏内时间' },
          h('div', { style: { fontSize: 13, color: C.text } },
            (props.clock && props.clock.label ? props.clock.label : '第1天 08:00') +
              ' · ' + (time.mode === 'fixed' ? '固定 ' + time.minutesPerTurn + ' 分钟/回合' : '按叙事估算'))),
        h(Section, { key: 'profiles', title: '骰子配置' },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            profiles.map(function (p) {
              var weighted = Array.isArray(p.weights) && p.weights.some(function (w) { return Number(w) > 1; });
              return h('span', {
                key: p.id,
                style: {
                  fontSize: 11.5,
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid ' + C.border,
                  color: weighted ? C.brand : C.dim,
                  background: C.layer,
                },
              }, (p.name || p.id) + (weighted ? ' · 自定义概率' : ''));
            }))),
        h(Section, { key: 'rolls', title: '骰点记录（最近 20 条）' },
          rolls.length
            ? h('div', null, rolls.map(function (r, i) {
                var color = r.outcome === 'success' || r.outcome === 'critical' ? C.ok : r.outcome === 'fail' || r.outcome === 'critical-fail' ? C.err : C.dim;
                return h('div', { key: i, style: { fontSize: 12, color: color, padding: '2px 0', borderBottom: '1px solid ' + C.border } }, fmtRoll(r) + (r.at ? ' · ' + r.at : ''));
              }))
            : h('div', { style: { fontSize: 12.5, color: C.faint } }, '还没有掷过骰。')),
      ]);
    }

    function HistoryTab(props) {
      var digests = Array.isArray(props.digests) ? props.digests.slice().reverse() : [];
      return h('div', null, digests.length
        ? digests.map(function (d, i) {
            return h('div', { key: i, style: { marginBottom: 10, padding: '8px 10px', background: C.layer, borderRadius: 8, border: '1px solid ' + C.border } }, [
              h('div', { key: 't', style: { fontSize: 11.5, color: C.brand, marginBottom: 2 } }, (d.title || '团史') + (d.turn ? ' · 回合 ' + d.turn : '') + (d.at ? ' · ' + d.at : '')),
              h('div', { key: 'b', style: { fontSize: 12.5, color: C.text, lineHeight: 1.65, whiteSpace: 'pre-wrap' } }, d.text || ''),
            ]);
          })
        : h('div', { style: { fontSize: 12.5, color: C.faint } }, '暂无团史记录。主持人会用 trpg_digest 记录关键剧情。'));
    }

    function WorldTab(props) {
      var w = props.world || {};
      var scene = props.scene || {};
      var list = function (items, render) {
        return Array.isArray(items) && items.length
          ? h('div', { style: { fontSize: 12.5, color: C.text, lineHeight: 1.7 } }, items.map(function (item, i) {
              return h('div', { key: i }, '· ' + (render ? render(item) : String(item)));
            }))
          : h('div', { style: { fontSize: 12, color: C.faint } }, '—');
      };
      return h('div', null, [
        h(Section, { key: 'meta', title: '世界' },
          h('div', null, [
            h(Row, { key: 'n', label: '名称', value: w.name || '未创建' }),
            h(Row, { key: 'g', label: '题材', value: w.genre || '—' }),
            h(Row, { key: 't', label: '基调', value: w.tone || '—' }),
          ])),
        w.summary ? h(Section, { key: 'sum', title: '设定概要' },
          h('div', { style: { fontSize: 12.5, color: C.dim, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, w.summary)) : null,
        h(Section, { key: 'scene', title: '当前场景' },
          h('div', null, [
            h(Row, { key: 's', label: '标题', value: scene.title || '未设置' }),
            h(Row, { key: 'l', label: '地点', value: scene.location || '—' }),
            h(Row, { key: 'g', label: '目标', value: scene.goal || '—' }),
          ])),
        Array.isArray(scene.participants) && scene.participants.length
          ? h(Section, { key: 'parts', title: '在场' }, list(scene.participants, function (p) { return typeof p === 'string' ? p : p.name || JSON.stringify(p); }))
          : null,
        h(Section, { key: 'factions', title: '势力' }, list(w.factions, function (f) { return typeof f === 'string' ? f : (f.name || '') + (f.desc ? '：' + f.desc : ''); })),
        h(Section, { key: 'locations', title: '地点' }, list(w.locations, function (l) { return typeof l === 'string' ? l : (l.name || '') + (l.desc ? '：' + l.desc : ''); })),
        h(Section, { key: 'hooks', title: '钩子 / 伏笔' }, list(w.hooks)),
        w.notes ? h(Section, { key: 'notes', title: '补充设定' },
          h('div', { style: { fontSize: 12.5, color: C.dim, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, w.notes)) : null,
      ]);
    }

    function insertInstruction(props, text) {
      try {
        var actions = props && props.inputActions;
        if (!actions || typeof actions.insertText !== 'function') return false;
        var span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined;
        var result = actions.insertText(text, span);
        return result !== false;
      } catch (error) {
        console.warn('[dsh-trpg-mode] 插入指令失败', error);
        return false;
      }
    }

    function ActionButton(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        title: props.title || '',
        style: {
          fontSize: 11.5,
          padding: '2px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid ' + (props.primary ? 'transparent' : C.border),
          background: props.primary ? C.brand : 'transparent',
          color: props.primary ? '#fff' : C.dim,
          whiteSpace: 'nowrap',
        },
      }, props.label);
    }

    function CampaignRow(props) {
      var c = props.campaign || {};
      var active = c.id === props.activeId;
      return h('div', { style: { padding: '7px 9px', marginBottom: 6, background: C.layer, border: '1px solid ' + (active ? C.brand : C.border), borderRadius: 8 } }, [
        h('div', { key: 'n', style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' } }, [
          h('span', { key: 'a', style: { fontWeight: 600, color: C.text, fontSize: 12.5 } }, c.name || '未命名团'),
          h('span', { key: 'b', style: { fontSize: 10.5, color: active ? C.brand : C.faint } }, active ? '当前团' : ''),
        ]),
        h('div', { key: 'm', style: { fontSize: 11.5, color: C.faint, marginTop: 2 } },
          [c.system || c.genre || '题材未定', c.pcName ? '角色 ' + c.pcName + ' Lv.' + (c.level || 1) : '', c.sceneTitle ? '场景 ' + c.sceneTitle : '', c.saveCount ? '存档 ' + c.saveCount : '']
            .filter(Boolean).join(' · ')),
        h('div', { key: 't', style: { fontSize: 10.5, color: C.faint, marginTop: 2 } }, '更新 ' + (c.updatedAt || '未知') + (c.clockLabel ? ' · ' + c.clockLabel : '')),
        h('div', { key: 'act', style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } }, [
          h(ActionButton, { key: 'v', label: active ? '查看' : '查看概览', onClick: function () { props.onView(c.id); } }),
          active ? null : h(ActionButton, { key: 's', label: '填入：切到此团', onClick: function () { insertInstruction(props, '切换到团「' + (c.name || c.id) + '」'); } }),
          active ? null : h(ActionButton, { key: 'l', label: '填入：读此团最近存档', onClick: function () { insertInstruction(props, '读取团「' + (c.name || c.id) + '」最近的存档'); } }),
        ].filter(Boolean)),
      ]);
    }

    function CampaignView(props) {
      var c = props.campaign || {};
      return h('div', null, [
        h('div', { key: 'h', style: { fontSize: 12.5, color: C.warn, lineHeight: 1.8, marginBottom: 10 } },
          '正在查看「' + (c.name || '未命名团') + '」的概览。面板实时数据只属于当前会话的团；切换需要主持人在对话里加载。'),
        h(Section, { key: 'meta', title: '团信息' },
          h('div', null, [
            h(Row, { key: 'n', label: '团名', value: c.name || '未命名' }),
            h(Row, { key: 's', label: '题材', value: c.system || c.genre || '—' }),
            h(Row, { key: 'p', label: '角色', value: c.pcName ? c.pcName + ' Lv.' + (c.level || 1) : '—' }),
            h(Row, { key: 'sc', label: '场景', value: c.sceneTitle || '—' }),
            h(Row, { key: 't', label: '游戏时间', value: c.clockLabel || '—' }),
            h(Row, { key: 'u', label: '更新时间', value: c.updatedAt || '未知' }),
            h(Row, { key: 'sv', label: '存档数', value: String(c.saveCount || 0) }),
          ])),
        h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } }, [
          h(ActionButton, { key: 'b', label: '回到当前团', onClick: props.onBack }),
          h(ActionButton, {
            key: 's',
            label: '填入：切换到此团',
            primary: true,
            onClick: function () { insertInstruction(props, '切换到团「' + (c.name || c.id) + '」'); },
          }),
        ]),
      ]);
    }

    function SaveTab(props) {
      var library = props.library || {};
      var campaigns = Array.isArray(library.campaigns) ? library.campaigns : [];
      var saves = Array.isArray(library.saves) ? library.saves : [];
      var activeId = props.activeId || '';
      return h('div', null, [
        h(Section, { key: 'camp', title: '团管理（' + campaigns.length + '）' },
          h('div', null, campaigns.length
            ? campaigns.map(function (c) {
                return h(CampaignRow, {
                  key: c.id,
                  campaign: c,
                  activeId: activeId,
                  inputActions: props.inputActions,
                  onView: props.onView,
                });
              })
            : h('div', { style: { fontSize: 12.5, color: C.faint } }, '还没有任何团。在对话里描述世界观即可开团。'))),
        h(Section, { key: 'saves', title: '存档管理（' + saves.length + '）' },
          h('div', null, [
            h('div', { key: 'acts', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } }, [
              h(ActionButton, { key: 'a', label: '填入：存档', onClick: function () { insertInstruction(props, '存档，槽位 手动存档'); } }),
              h(ActionButton, { key: 'b', label: '填入：列出存档', onClick: function () { insertInstruction(props, '列出所有存档'); } }),
              h(ActionButton, { key: 'c', label: '填入：新建团', onClick: function () { insertInstruction(props, '另起一个新团'); } }),
            ]),
            saves.length
              ? saves.slice(0, 60).map(function (s, i) {
                  return h('div', { key: i, style: { padding: '6px 0', borderBottom: '1px solid ' + C.border } }, [
                    h('div', { key: 'a', style: { fontSize: 12, color: C.text } },
                      (s.campaign ? '【' + s.campaign + '】' : '') + '槽位 ' + (s.slot || '—') + (s.note ? ' · ' + s.note : '')),
                    h('div', { key: 'b', style: { fontSize: 10.5, color: C.faint, marginTop: 2, wordBreak: 'break-all' } }, (s.createdAt || '') + ' · ' + (s.name || s.file)),
                    h('div', { key: 'c', style: { marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
                      h(ActionButton, {
                        key: 'l',
                        label: '填入：读这个档',
                        onClick: function () { insertInstruction(props, '读取存档「' + (s.name || s.file) + '」'); },
                      }),
                      h(ActionButton, {
                        key: 'd',
                        label: '填入：删这个档',
                        onClick: function () { insertInstruction(props, '删除存档「' + (s.name || s.file) + '」'); },
                      }),
                    ]),
                  ]);
                })
              : h('div', { style: { fontSize: 12.5, color: C.faint } }, '还没有存档。'),
          ])),
      ]);
    }

    var SETUP_LABELS = {
      none: '未开始',
      world_q: '世界观问卷',
      world_ready: '世界观已生成',
      pc_method: '选择角色来源',
      pc_build: '创建角色',
      pc_pick: '挑选人物卡',
      place_method: '选择地点方式',
      place_done: '地点已生成',
      ready: '可以开始游戏',
    };
    var SETUP_FLOW = [
      ['world_q', '问卷'],
      ['world_ready', '世界'],
      ['pc_build', '车卡'],
      ['place_method', '地点'],
      ['ready', '开局'],
    ];

    function SetupTab(props) {
      var setup = props.setup && typeof props.setup === 'object' ? props.setup : {};
      var stage = setup.stage || 'none';
      var answers = Array.isArray(setup.answers) ? setup.answers : [];
      var answered = Math.min(answers.length, 20);
      var cards = Array.isArray(setup.pcCards) ? setup.pcCards : [];
      var rolls = Array.isArray(setup.pcRolls) ? setup.pcRolls : [];
      var draft = setup.placeDraft && typeof setup.placeDraft === 'object' ? setup.placeDraft : null;
      var lastRoll = rolls.length ? rolls[rolls.length - 1] : null;
      var missing = [];
      for (var i = 1; i <= 20; i += 1) {
        var qid = 'q' + i;
        if (!answers.some(function (a) { return a && a.id === qid; })) missing.push(qid);
      }
      var next = '开局完成，直接开始游戏。';
      if (stage === 'none') next = '还没有开局：让主持人调用 trpg_setup 开始 20 问问卷。';
      else if (stage === 'world_q') next = '问卷进度 ' + answered + '/20：每批 4 题作答，答完让主持人生成世界。';
      else if (stage === 'world_ready') next = '世界已生成：选择角色来源（购点 / 随机 / 主持人人物卡）。';
      else if (stage === 'pc_build') next = setup.pcMethod === 'roll' ? '随机生成：确认骰面后定稿。' : '购点中：分配属性并定稿。';
      else if (stage === 'pc_pick') next = '挑选一张人物卡（op=pc_pick）。';
      else if (stage === 'place_method') next = '选择开始地点方式（购点 / 随机）。';
      else if (stage === 'place_done') next = '地点已生成：确认后写入场景并开始第一幕。';

      var st = function (idx, label) {
        var on = stage === label[0] || (label[0] === 'pc_build' && stage === 'pc_pick') || (label[0] === 'place_method' && stage === 'place_done');
        return h('div', {
          key: label[0],
          style: {
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            border: '1px solid ' + (on ? C.brand : C.border),
            color: on ? C.brand : C.faint,
          },
        }, idx + 1 + '. ' + label[1]);
      };

      return h('div', null, [
        h(Section, { key: 'flow', title: '开局进度' },
          h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
            SETUP_FLOW.map(function (label, idx) { return st(idx, label); }))),
        h(Section, { key: 'stage', title: '当前阶段' },
          h('div', null, [
            h(Row, { key: 's', label: '阶段', value: SETUP_LABELS[stage] || stage }),
            h(Row, { key: 'q', label: '问卷', value: answered + '/20' + (missing.length ? '（未答 ' + missing.length + '）' : '') }),
            setup.pcMethod ? h(Row, { key: 'm', label: '角色来源', value: setup.pcMethod === 'cards' ? '主持人人物卡' : setup.pcMethod === 'roll' ? '随机生成' : '购点' }) : null,
            setup.pointBuy && setup.pointBuy.template ? h(Row, { key: 't', label: '车卡模板', value: setup.pointBuy.template + (setup.pointBuy.remaining !== undefined ? '（剩 ' + setup.pointBuy.remaining + ' 点）' : '') }) : null,
            lastRoll ? h(Row, { key: 'r', label: '随机属性', value: Object.keys(lastRoll.attrs || {}).map(function (k) { return k + ' ' + lastRoll.attrs[k]; }).join('，') }) : null,
            cards.length ? h(Row, { key: 'c', label: '人物卡', value: cards.length + ' 张待选' }) : null,
            draft ? h(Row, { key: 'p', label: '地点草稿', value: (draft.selected || []).map(function (x) { return x.name; }).join('、') || '—' }) : null,
          ].filter(Boolean))),
        h(Section, { key: 'next', title: '下一步' },
          h('div', { style: { fontSize: 12.5, color: C.dim, lineHeight: 1.7 } }, next)),
        h(Section, { key: 'acts', title: '快捷指令（填入输入框后回车）' },
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
            h(ActionButton, { key: 'a1', label: '填入：开始 20 问', onClick: function () { insertInstruction(props, '开始跑团开局问卷'); } }),
            h(ActionButton, { key: 'a2', label: '填入：快速开局', onClick: function () { insertInstruction(props, '用默认答案快速开局'); } }),
            h(ActionButton, { key: 'a3', label: '填入：自建购点', onClick: function () { insertInstruction(props, '我要自己车卡，用购点法'); } }),
            h(ActionButton, { key: 'a4', label: '填入：随机角色', onClick: function () { insertInstruction(props, '角色用随机生成'); } }),
            h(ActionButton, { key: 'a5', label: '填入：人物卡', onClick: function () { insertInstruction(props, '给我 3 张人物卡选'); } }),
            h(ActionButton, { key: 'a6', label: '填入：地点购点', onClick: function () { insertInstruction(props, '开始地点用购点法'); } }),
            h(ActionButton, { key: 'a7', label: '填入：地点随机', onClick: function () { insertInstruction(props, '开始地点随机生成'); } }),
            h(ActionButton, { key: 'a8', label: '填入：重开问卷', onClick: function () { insertInstruction(props, '重开开局问卷'); } }),
          ])),
      ]);
    }

    var TABS = [
      { id: 'setup', label: '开局', render: SetupTab },
      { id: 'pc', label: '角色', render: PcTab },
      { id: 'dice', label: '骰子', render: DiceTab },
      { id: 'history', label: '团史', render: HistoryTab },
      { id: 'world', label: '世界', render: WorldTab },
      { id: 'save', label: '存档', render: SaveTab },
    ];

    function Panel(props) {
      var useProjection = props.useProjection;
      var value = typeof useProjection === 'function' ? useProjection('trpg') : undefined;
      var state = value && typeof value === 'object' ? value : null;
      var activeState = React.useState('pc');
      var active = activeState[0];
      var setActive = activeState[1];
      var viewState = React.useState('');
      var viewId = viewState[0];
      var setViewId = viewState[1];

      if (!state || (!state.campaign || (!state.campaign.name && !state.world.name && !state.pc.name))) {
        return h('div', { style: { padding: 16, fontSize: 12.5, color: C.dim, lineHeight: 1.9 } }, [
          h('div', { key: 'a', style: { fontSize: 13, color: C.text, marginBottom: 8, fontWeight: 600 } }, '跑团面板'),
          h('div', { key: 'b' }, '还没有开始游戏。在对话里描述你想要的「世界观」（题材 / 时代 / 基调 / 限制），主持人会生成世界与角色。'),
          h('div', { key: 'c', style: { marginTop: 8, color: C.faint } }, '提示：该模式只暴露 trpg_* 工具，主持人无法读写文件或执行命令。'),
        ]);
      }

      var library = state.library && typeof state.library === 'object' ? state.library : {};
      var campaigns = Array.isArray(library.campaigns) ? library.campaigns : [];
      var activeId = state.campaign.id || '';
      var viewed = viewId ? campaigns.filter(function (c) { return c.id === viewId; })[0] : null;
      var viewingOther = !!(viewed && viewed.id !== activeId);

      var current = TABS.filter(function (t) { return t.id === active; })[0] || TABS[0];
      var Render = viewingOther ? CampaignView : current.render;

      var headerTitle = viewingOther
        ? (viewed.name || '未命名团') + '（概览）'
        : (state.campaign.name || state.world.name || '未命名团');

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: C.bg,
          color: C.text,
          fontSize: 13,
        },
      }, [
        h('div', {
          key: 'head',
          style: {
            padding: '10px 12px 8px',
            borderBottom: '1px solid ' + C.border,
            background: C.layer,
            flex: '0 0 auto',
          },
        }, [
          h('div', { key: 'name', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } }, [
            h('div', { key: 'l', style: { fontWeight: 600, fontSize: 13.5 } }, headerTitle),
            h('div', { key: 'r', style: { fontSize: 11, color: C.faint } }, state.clock ? state.clock.label : ''),
          ]),
          h('div', { key: 'sys', style: { fontSize: 11.5, color: C.faint, marginTop: 2 } },
            (state.campaign.system ? state.campaign.system + ' · ' : '') + (state.world.genre || '题材未定')),
          h('div', { key: 'switch', style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 } }, [
            h('span', { key: 'lb', style: { fontSize: 11, color: C.faint, whiteSpace: 'nowrap' } }, '看哪个团'),
            h('select', {
              key: 'sel',
              value: viewId || activeId,
              onChange: function (event) { setViewId(event && event.target ? event.target.value : ''); },
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 11.5,
                padding: '3px 6px',
                borderRadius: 6,
                border: '1px solid ' + C.border,
                background: C.bg,
                color: C.text,
              },
            }, campaigns.length
              ? campaigns.map(function (c) {
                  return h('option', { key: c.id, value: c.id }, (c.name || '未命名') + (c.id === activeId ? '（当前）' : '') + (c.saveCount ? ' · 存档' + c.saveCount : ''));
                })
              : h('option', { key: 'none', value: activeId }, state.campaign.name || '当前团')),
            viewingOther ? h(ActionButton, { key: 'back', label: '回到当前团', onClick: function () { setViewId(''); } }) : null,
          ].filter(Boolean)),
          h('div', { key: 'tabs', style: { display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' } },
            TABS.map(function (t) {
              var on = t.id === active && !viewingOther;
              return h('button', {
                key: t.id,
                onClick: function () { setViewId(''); setActive(t.id); },
                style: {
                  fontSize: 12,
                  padding: '3px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  border: '1px solid ' + (on ? 'transparent' : C.border),
                  background: on ? C.brand : 'transparent',
                  color: on ? '#fff' : C.dim,
                },
              }, t.label);
            })),
        ]),
        h('div', {
          key: 'body',
          style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 12px 24px' },
        }, h(Render, Object.assign({}, state, {
          inputActions: props.inputActions,
          library: library,
          campaigns: campaigns,
          activeId: activeId,
          campaign: viewingOther ? viewed : state.campaign,
          onView: function (id) { setViewId(id); },
          onBack: function () { setViewId(''); },
        }))),
      ]);
    }

    function HeaderButton(props) {
      var useSession = props.useSession;
      var preset;
      try {
        preset = typeof useSession === 'function'
          ? useSession(function (snapshot) {
              return snapshot && (snapshot.agentPreset || (snapshot.header && snapshot.header.agentPreset));
            })
          : undefined;
      } catch (error) {
        preset = undefined;
      }
      if (!preset || !PRESETS[preset]) return null;
      return h('button', {
        type: 'button',
        title: '打开跑团面板',
        onClick: function () { openTrpgTab(props.ctx || {}); },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 24,
          padding: '0 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid ' + C.border,
          background: 'transparent',
          color: C.dim,
          cursor: 'pointer',
        },
      }, '🎲 跑团');
    }

    /** 等 sidebarRightTabs / sidebarRight 服务出现（最多 ~30s），然后注册标签类型。 */
    function bootTabType(ctx) {
      var disposed = false;
      var disposers = [];
      var timer = null;
      var attempts = 0;
      function tryRegister() {
        if (disposed) return;
        attempts += 1;
        try {
          var tabs = ctx.get ? ctx.get('sidebarRightTabs') : undefined;
          var ctrl = ctx.get ? ctx.get('sidebarRight') : undefined;
          if (tabs && typeof tabs.register === 'function' && ctrl) {
            var dispose = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: function () { return '跑团'; },
              guide: [{
                id: 'sheet',
                order: 300,
                title: function () { return '跑团'; },
                description: function () { return '角色卡、骰点记录与世界设定'; },
              }],
            });
            if (typeof dispose === 'function') disposers.push(dispose);
            return;
          }
        } catch (error) {
          console.warn('[dsh-trpg-mode] 注册跑团标签失败', error);
          return;
        }
        if (attempts < 120) timer = setTimeout(tryRegister, 250);
      }
      tryRegister();
      return function () {
        disposed = true;
        if (timer) clearTimeout(timer);
        for (var i = 0; i < disposers.length; i += 1) {
          try { disposers[i](); } catch (error) { /* ignore */ }
        }
      };
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        try {
          ctx.effect(function () { return bootTabType(ctx); });
        } catch (error) {
          console.warn('[dsh-trpg-mode] 启动跑团标签失败', error);
        }

        try {
          ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Panel);
          });
        } catch (error) {
          console.warn('[dsh-trpg-mode] 注册跑团面板失败', error);
        }

        try {
          ctx.slots.inject('conversation.session.header.utilities', function () {
            return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'trpg-sheet-open', order: 20, label: '跑团' }, function (props) {
              return h(HeaderButton, Object.assign({}, props, { ctx: ctx }));
            });
          });
        } catch (error) {
          console.warn('[dsh-trpg-mode] 注册跑团按钮失败', error);
        }
      },
    };
  },
});
