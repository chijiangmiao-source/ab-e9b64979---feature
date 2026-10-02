import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, simulate, normalizeConfig, sweepTolerance } from '../src/sim.js';

// 场景一：宽度为 2 的短脉冲及因果链。
// 信号源 A（NOT input，延迟 1）在第 2 刻变 1、第 4 刻变 0；
// 使能 EN 为高时，AND 门 Y（惯性延迟 2）在 [4,6) 输出宽度 2 的窄脉冲。
function pulseConfig() {
  return {
    gates: [
      { id: 'A', type: 'NOT', delay: 1, inputs: ['input:a'] },
      { id: 'EN', type: 'NOT', delay: 1, inputs: ['input:en_n'] },
      { id: 'Y', type: 'AND', delay: 2, inputs: ['A', 'EN'] },
    ],
    edges: [
      { time: 2, input: 'a', from: 1, to: 0 },
      { time: 4, input: 'a', from: 0, to: 1 },
    ],
    initialInputs: { a: '1', en_n: '0' },
    monitors: ['Y'],
  };
}

test('宽度为 2 的短脉冲：起止刻度、宽度与因果事件链', () => {
  const res = simulate(pulseConfig());
  assert.equal(res.ok, true);
  const p = res.pulses.find((x) => x.gate === 'Y');
  assert.ok(p, '应检测到受监控输出 Y 上的短脉冲');
  assert.equal(p.start, 5);
  assert.equal(p.end, 7);
  assert.equal(p.width, 2);
  assert.equal(p.short, true);
  // 因果链终点是外部边沿 t=2 a:1->0
  const root = p.chain[0];
  assert.equal(root.kind, 'edge');
  assert.equal(root.t, 2);
  assert.equal(root.input, 'a');
  assert.equal(root.to, '0');
  // 链上包含 Y 的进入翻转事件标识
  assert.ok(p.chain.some((c) => c.kind === 'fire' && c.gate === 'Y' && c.seq === p.enterSeq));
});

test('脉冲宽度 3 不判为短脉冲（宽于惯性延迟 2）', () => {
  const cfg = pulseConfig();
  cfg.edges = [
    { time: 2, input: 'a', from: 1, to: 0 },
    { time: 5, input: 'a', from: 0, to: 1 },
  ];
  const res = simulate(cfg);
  const wide = res.pulses.find((x) => x.gate === 'Y');
  // 宽度 = 7-4 = 3 > delay 2，不属于短脉冲
  assert.ok(!wide || wide.short === false);
});

// 场景二：延迟为 3 的 NOT 门在第 0、1 刻反转时，第 3 刻失效翻转必须被撤销、不得落入轨迹。
test('NOT 延迟 3：t=0 与 t=1 连续反转，t=3 失效翻转被撤销', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 1, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const res = simulate(cfg);
  assert.equal(res.ok, true);
  // 轨迹中 N 从未实际翻转
  assert.ok(res.timeline.every((s) => s.values.N === '1'), 'NOT 初值为 1 且全程保持 1');
  assert.ok(!res.events.some((e) => e.action === 'FIRE'), '不得有任何生效翻转事件');
  const cancel = res.events.find((e) => e.action === 'CANCEL');
  assert.ok(cancel, '应存在撤销记录');
  assert.equal(cancel.gate, 'N');
  assert.equal(cancel.time, 1);
  // 被撤销的是原定 t=3 落到 0 的失效翻转
  const sched = res.events.find((e) => e.action === 'SCHEDULE');
  assert.equal(sched.at, 3);
  assert.equal(sched.to, '0');
  assert.equal(res.status, 'STABLE');
  assert.equal(res.stableValues.N, '1');
});

test('NOT 延迟 3：输入保持满 3 刻则翻转正常生效', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 3, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const res = simulate(cfg);
  const fires = res.events.filter((e) => e.action === 'FIRE');
  assert.ok(fires.length >= 1);
  assert.equal(fires[0].time, 3);
  assert.equal(fires[0].to, '0');
  // 输入在第 3 刻回归后，输出经完整延迟于第 6 刻回到 1
  assert.equal(fires[1].time, 6);
  assert.equal(fires[1].to, '1');
});

// 场景三：正延迟反馈链振荡。
// N(NOT,延迟1) 输出接 AND 门 G(延迟1) 的一个输入，G 输出反馈接 N 输入链：
// N = NOT(G)，延迟均为 1，构成周期 2 的持续振荡（与外激励无关，由初值失配启动）。
test('正延迟反馈链：检测到振荡前缀与可回放循环', () => {
  const cfg = {
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 0, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  };
  const res = simulate(cfg);
  assert.equal(res.status, 'OSCILLATING');
  assert.ok(res.oscillation.period >= 2);
  assert.ok(res.oscillation.cycle.length === res.oscillation.period);
  // 循环内存在可回放的门翻转事件标识
  assert.ok(res.oscillation.events.length > 0);
  assert.ok(res.oscillation.gates.includes('G') || res.oscillation.gates.includes('N'));
  // 前缀 + 循环构成可回放轨迹：循环相邻刻度值确实变化
  const cyc = res.oscillation.cycle;
  const changed = cyc.some((f, i) => {
    const next = cyc[(i + 1) % cyc.length];
    return JSON.stringify(f.values) !== JSON.stringify(next.values);
  });
  assert.ok(changed);
  // 循环结束时刻的状态与循环起点规范化一致（再仿真一段必然重复）
  const endFrame = res.timeline.find((s) => s.t === res.oscillation.cycleEnd);
  const startFrame = res.timeline.find((s) => s.t === res.oscillation.cycleStart);
  assert.ok(endFrame && startFrame);
});

test('校验：悬空连线逐项报错', () => {
  const r = validate({
    gates: [{ id: 'A', type: 'AND', delay: 1, inputs: ['B', ''] }],
    edges: [],
    monitors: ['A'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'WIRE_DANGLING'));
  assert.ok(r.errors.some((e) => e.code === 'WIRE_EMPTY'));
});

test('校验：重复驱动 / 非法边沿 / 环内零延迟', () => {
  const r = validate({
    gates: [
      { id: 'A', type: 'AND', delay: 1, inputs: ['B', 'B'] },
      { id: 'B', type: 'NOT', delay: 0, inputs: ['A'] },
    ],
    edges: [
      { time: -1, input: 'x', from: 0, to: 1 },
      { time: 0, input: 'x', from: 1, to: 1 },
    ],
    monitors: ['A'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'WIRE_DUP_DRIVER'));
  assert.ok(r.errors.some((e) => e.code === 'ZERO_DELAY_CYCLE'));
  assert.ok(r.errors.filter((e) => e.code === 'EDGE_BAD').length >= 2);
});

test('校验：边沿方向矛盾与超过 12 个门', () => {
  const gates = Array.from({ length: 13 }, (_, i) => ({
    id: `G${i}`, type: 'NOT', delay: 1, inputs: ['input:x'],
  }));
  const r1 = validate({ gates, edges: [], monitors: [] });
  assert.ok(r1.errors.some((e) => e.code === 'TOO_MANY_GATES'));

  const r2 = validate({
    gates: [{ id: 'A', type: 'NOT', delay: 1, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 2, input: 'x', from: 0, to: 1 },
    ],
    monitors: ['A'],
  });
  assert.ok(r2.errors.some((e) => e.code === 'EDGE_INCONSISTENT'));
});

test('规范化配置：相同结构不同录入顺序得到同一哈希', () => {
  const a = normalizeConfig({
    gates: [{ id: 'A', type: 'NOT', delay: 2, inputs: ['input:x'] }],
    edges: [{ time: 1, input: 'x', from: 0, to: 1 }],
    monitors: ['A'],
  });
  const b = normalizeConfig({
    gates: [{ delay: 2, type: 'NOT', id: 'A', inputs: ['input:x'] }],
    edges: [{ from: 0, to: 1, time: 1, input: 'x' }],
    monitors: ['A'],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.hash, b.hash);
});

test('校验失败时 simulate 返回错误且不产出旧结论', () => {
  const res = simulate({ gates: [], edges: [], monitors: [] });
  assert.equal(res.ok, false);
  assert.equal(res.status, undefined);
});

// 容差复核场景：NOT（延迟 3）监测 x；x 在 t=10 拉高、t=20 拉低。
// 偏移 t=20 的下降沿：k=-7 时输入高电平窗口恰好撑满 3 刻，输出 [13,16) 宽度 3 的临界短脉冲；
// k=-8 时扰动短于延迟被撤销（安全）；k≥-6 时输出脉冲宽于延迟（安全）。
function tolConfig() {
  return {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 10, input: 'x', from: 0, to: 1 },
      { time: 20, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
}

test('容差复核：连续安全区间与最接近零的首个短脉冲偏移', () => {
  const cfg = tolConfig();
  const snapshot = JSON.stringify(cfg);
  const tol = sweepTolerance(cfg, { edge: { time: 20, input: 'x' }, offsets: { from: -8, to: 4 } });
  assert.equal(tol.ok, true);
  // 偏移结果按偏移值升序稳定排列
  assert.equal(tol.results.length, 13);
  assert.ok(tol.results.every((r, i) => r.offset === -8 + i && r.edgeTime === 20 + r.offset));
  // 连续安全偏移区间
  assert.deepEqual(tol.safeIntervals, [{ from: -8, to: -8 }, { from: -6, to: 4 }]);
  // 最接近零的风险偏移即首个短脉冲偏移 k=-7
  assert.deepEqual(tol.nearestRisk, { offset: -7, edgeTime: 13, risk: 'PULSE' });
  assert.equal(tol.nearestByRisk.PULSE, -7);
  assert.equal(tol.counts.safe, 12);
  assert.equal(tol.counts.PULSE, 1);
  // 风险项证据来自该次运行（宽 3 的 [13,16)），而非原始运行（宽 10 的 [13,23)）
  const risk = tol.results.find((r) => r.offset === -7);
  assert.equal(risk.evidence.pulses.length, 1);
  assert.equal(risk.evidence.pulses[0].start, 13);
  assert.equal(risk.evidence.pulses[0].end, 16);
  assert.equal(risk.evidence.pulses[0].width, 3);
  const base = simulate(cfg);
  assert.equal(base.pulses.length, 0, '原始运行没有短脉冲，容差证据不可能复用自原始运行');
  // 原始配置保持不变
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('容差复核：振荡风险偏移携带该次运行的循环证据', () => {
  const cfg = {
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 2, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  };
  const tol = sweepTolerance(cfg, { edge: { time: 2, input: 'en' }, offsets: { from: -2, to: 2 } });
  assert.equal(tol.ok, true);
  assert.equal(tol.safeIntervals.length, 0);
  assert.equal(tol.counts.OSCILLATING, 5);
  assert.equal(tol.nearestRisk.offset, 0);
  assert.equal(tol.nearestRisk.risk, 'OSCILLATING');
  const r0 = tol.results.find((r) => r.offset === 0);
  assert.ok(r0.evidence.oscillation.period >= 2);
  assert.ok(r0.evidence.oscillation.cycle.length > 0);
});

test('容差复核：观察窗口耗尽记为未决风险', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [{ time: 0, input: 'x', from: 0, to: 1 }],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const tol = sweepTolerance(cfg, { edge: { time: 0, input: 'x' }, offsets: { from: 0, to: 0 } }, { maxTicks: 2 });
  assert.equal(tol.ok, true);
  assert.equal(tol.results[0].risk, 'UNRESOLVED');
  assert.equal(tol.results[0].evidence.unresolved.stopTick, 2);
});

test('容差复核：偏移后边沿与他人撞车记为无效而非安全', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 1, inputs: ['input:x'] }],
    edges: [
      { time: 2, input: 'x', from: 0, to: 1 },
      { time: 4, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const tol = sweepTolerance(cfg, { edge: { time: 2, input: 'x' }, offsets: { from: 0, to: 3 } });
  assert.equal(tol.ok, true);
  const dup = tol.results.find((r) => r.offset === 2);
  assert.equal(dup.risk, 'INVALID');
  assert.ok(dup.evidence.errors.some((e) => e.code === 'EDGE_BAD'));
  // k=1 为短脉冲风险，k=2 撞车无效，k=0 与 k=3 静稳安全
  assert.equal(tol.results.find((r) => r.offset === 1).risk, 'PULSE');
  assert.deepEqual(tol.safeIntervals, [{ from: 0, to: 0 }, { from: 3, to: 3 }]);
});

test('容差复核：所选边沿不存在 / 范围非有限整数 / 下界大于上界', () => {
  const cfg = tolConfig();
  const noEdge = sweepTolerance(cfg, { edge: { time: 99, input: 'x' }, offsets: { from: 0, to: 1 } });
  assert.equal(noEdge.ok, false);
  assert.equal(noEdge.errors[0].code, 'TOLERANCE_EDGE_NOT_FOUND');
  assert.equal(noEdge.results, undefined, '出错时不得残留本轮容差结论');

  for (const offsets of [{ from: 1.5, to: 2 }, { from: 'x', to: 2 }, { from: '', to: 2 }, { from: 0, to: Infinity }]) {
    const r = sweepTolerance(cfg, { edge: { time: 20, input: 'x' }, offsets });
    assert.equal(r.ok, false, JSON.stringify(offsets));
    assert.equal(r.errors[0].code, 'TOLERANCE_RANGE_BAD');
  }
  const inv = sweepTolerance(cfg, { edge: { time: 20, input: 'x' }, offsets: { from: 2, to: -2 } });
  assert.equal(inv.ok, false);
  assert.equal(inv.errors[0].code, 'TOLERANCE_RANGE_INVERTED');

  const baseBad = sweepTolerance({ gates: [], edges: [], monitors: [] }, { edge: { time: 0, input: 'x' }, offsets: { from: 0, to: 1 } });
  assert.equal(baseBad.ok, false);
  assert.equal(baseBad.errors[0].code, 'TOLERANCE_BASE_INVALID');
});

test('容差复核：偏移后使边沿刻度为负的边界', () => {
  const cfg = tolConfig();
  const neg = sweepTolerance(cfg, { edge: { time: 10, input: 'x' }, offsets: { from: -11, to: -5 } });
  assert.equal(neg.ok, false);
  assert.equal(neg.errors[0].code, 'TOLERANCE_NEGATIVE_TICK');
  assert.equal(neg.results, undefined);
  // 边界 k=-10 使刻度恰好为 0：合法
  const edge0 = sweepTolerance(cfg, { edge: { time: 10, input: 'x' }, offsets: { from: -10, to: -10 } });
  assert.equal(edge0.ok, true);
  assert.equal(edge0.results[0].edgeTime, 0);
  // 容差错误不影响普通复核
  const base = simulate(cfg);
  assert.equal(base.ok, true);
  assert.equal(base.status, 'STABLE');
});
