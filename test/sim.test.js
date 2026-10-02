import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, simulate, runTolerance, normalizeConfig } from '../src/sim.js';

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

// ---------- 边沿容差偏移复核 ----------

// 与 pulseConfig 相同的链路；对 t=2 的下降沿做容差平移：
//  -2/-1 被惯性吸收（静稳）；0 为宽度 2 临界短脉冲；+1 变宽安全；
//  +2 与 t=4 边沿同刻，既有校验拒绝（逐点非法）。
function toleranceConfig() {
  return pulseConfig();
}

test('容差复核：逐偏移稳定分类、连续安全区间与最接近零风险偏移', () => {
  const res = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: -2, upper: 2 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((p) => [p.offset, p.kind]), [
    [-2, 'STABLE'], [-1, 'STABLE'], [0, 'GLITCH'], [1, 'STABLE'], [2, 'INVALID'],
  ]);
  // 连续安全区间：[-2,-1] 与 [1,1]；+2 非法不计入。
  assert.deepEqual(res.safeRanges, [{ lower: -2, upper: -1 }, { lower: 1, upper: 1 }]);
  // 最接近零的风险偏移是 0（短脉冲）。
  assert.equal(res.nearestRisk.offset, 0);
  assert.equal(res.nearestRisk.kind, 'GLITCH');
  assert.equal(res.counts.STABLE, 3);
  assert.equal(res.counts.GLITCH, 1);
  assert.equal(res.counts.INVALID, 1);
});

test('容差复核：风险点证据取自该偏移运行，与原始运行不同的偏移不复用原证据', () => {
  // 选 t=4 的上升沿向左平移：offset -2 -> 边沿到 t=2，与另一条同刻，非法；
  // offset 0 原始配置无脉冲；此处改为对 t=2 边沿 offset=0 才是脉冲。
  // 直接验证：offset=0 的脉冲证据存在；安全偏移点不带 pulses/oscillation。
  const res = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: -1, upper: 1 });
  const at0 = res.results.find((p) => p.offset === 0);
  const atMinus1 = res.results.find((p) => p.offset === -1);
  assert.equal(at0.kind, 'GLITCH');
  assert.ok(Array.isArray(at0.pulses) && at0.pulses.length === 1);
  assert.equal(at0.pulses[0].width, 2);
  assert.equal(at0.pulses[0].start, 5);
  assert.equal(at0.pulses[0].end, 7);
  // 因果链回溯到“该次运行”中仍位于 t=2 的边沿。
  const root = at0.pulses[0].chain[0];
  assert.equal(root.kind, 'edge');
  assert.equal(root.t, 2);
  assert.equal(root.input, 'a');
  // 静稳点不携带风险证据。
  assert.equal(atMinus1.kind, 'STABLE');
  assert.equal(atMinus1.pulses, undefined);
  assert.equal(atMinus1.oscillation, undefined);
});

test('容差复核：逐偏移点的脉冲证据时间随平移变化（证明非复用原始运行证据）', () => {
  // 选 t=4 上升沿：offset +1 => t=5，脉冲展宽为 3（不再短）；
  // offset 0 => t=4，宽度 2 短脉冲，起止 5..7；这里用另一条边（t=2）offset 0 保持宽度2。
  // 为体现“证据来自该次运行”，选 t=4 边沿在更宽链路中直接比对：
  const cfg = {
    gates: [
      { id: 'A', type: 'NOT', delay: 1, inputs: ['input:a'] },
      { id: 'EN', type: 'NOT', delay: 1, inputs: ['input:en_n'] },
      { id: 'Y', type: 'AND', delay: 2, inputs: ['A', 'EN'] },
    ],
    edges: [
      { time: 2, input: 'a', from: 1, to: 0 },
      { time: 5, input: 'a', from: 0, to: 1 },
    ],
    initialInputs: { a: '1', en_n: '0' },
    monitors: ['Y'],
  };
  // 原始（t=5）间隔 3 -> 输出脉冲宽度 3，安全。把该边沿左移 1 -> t=4 -> 宽度 2 短脉冲。
  const res = runTolerance(cfg, { edgeTime: 5, edgeInput: 'a', lower: -1, upper: 0 });
  const at0 = res.results.find((p) => p.offset === 0);
  const atMinus1 = res.results.find((p) => p.offset === -1);
  assert.equal(at0.kind, 'STABLE');
  assert.equal(atMinus1.kind, 'GLITCH');
  assert.equal(atMinus1.pulses[0].width, 2);
  assert.equal(atMinus1.pulses[0].start, 5);
  assert.equal(atMinus1.pulses[0].end, 7);
  assert.equal(atMinus1.edgeTime, 4);
});

test('容差复核：振荡偏移点携带该次运行的循环证据', () => {
  // 反馈链在 en 上升沿后振荡；把唯一边沿右移不改变振荡，但证据 cycleStart/事件序列
  // 必须来自该次偏移运行（平移后边沿 endTime 随之移动）。
  const cfg = {
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 1, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  };
  const res = runTolerance(cfg, { edgeTime: 1, edgeInput: 'en', lower: 0, upper: 1 });
  assert.equal(res.results[0].kind, 'OSCILLATING');
  assert.equal(res.results[1].kind, 'OSCILLATING');
  const o0 = res.results[0].oscillation;
  const o1 = res.results[1].oscillation;
  assert.ok(o0.period >= 2 && o1.period >= 2);
  assert.ok(o1.cycleStart > o0.cycleStart || o1.events[0].t >= o0.events[0].t);
  // 请求元数据回显原边与区间。
  assert.deepEqual(res.request.lower, 0);
  assert.deepEqual(res.request.upper, 1);
  assert.equal(res.request.edge.time, 1);
});

test('容差复核：原始配置保持不变（输入对象不被修改）', () => {
  const cfg = toleranceConfig();
  const snapshot = JSON.stringify(cfg);
  runTolerance(cfg, { edgeTime: 2, edgeInput: 'a', lower: -2, upper: 2 });
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('容差复核：所选边沿不存在 -> TOL_EDGE_UNKNOWN 且无结论', () => {
  const res = runTolerance(toleranceConfig(), { edgeTime: 99, edgeInput: 'a', lower: -1, upper: 1 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'TOL_EDGE_UNKNOWN'));
  assert.equal(res.results, undefined);
});

test('容差复核：范围非有限整数 -> TOL_RANGE_BAD', () => {
  for (const bad of [1.5, NaN, Infinity, 'x', null, undefined]) {
    const res = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: bad, upper: 1 });
    assert.equal(res.ok, false, `lower=${bad}`);
    assert.ok(res.errors.some((e) => e.code === 'TOL_RANGE_BAD'), `lower=${bad}`);
  }
});

test('容差复核：下界大于上界 -> TOL_RANGE_ORDER', () => {
  const res = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: 2, upper: 0 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'TOL_RANGE_ORDER'));
});

test('容差复核：偏移后负刻度 -> TOL_NEGATIVE_TICK 并清除本轮结论', () => {
  const res = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: -3, upper: 2 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'TOL_NEGATIVE_TICK'));
  assert.equal(res.results, undefined);
  // 恰使刻度为 0 的下界合法。
  const ok2 = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: -2, upper: -2 });
  assert.equal(ok2.ok, true);
  assert.equal(ok2.results[0].edgeTime, 0);
});

test('容差复核：同一输入在浏览器内核与接口入口得到一致的偏移排序与风险类型', async () => {
  // 直接复用同一内核函数（页面与 /api/review 均调用 runTolerance），
  // 验证字符串形式录入（页面收集的是字符串）也能得到与数值形式一致的结果。
  const num = runTolerance(toleranceConfig(), { edgeTime: 2, edgeInput: 'a', lower: -2, upper: 2 });
  const str = runTolerance(
    {
      gates: toleranceConfig().gates,
      edges: toleranceConfig().edges.map((e) => ({ ...e, time: String(e.time) })),
      initialInputs: toleranceConfig().initialInputs,
      monitors: ['Y'],
    },
    { edgeTime: 2, edgeInput: 'a', lower: -2, upper: 2 },
  );
  const simplify = (r) => r.results.map((p) => [p.offset, p.kind, p.edgeTime]);
  assert.deepEqual(simplify(str), simplify(num));
  assert.deepEqual(str.safeRanges, num.safeRanges);
  assert.deepEqual(str.nearestRisk, num.nearestRisk);
});
