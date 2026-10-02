// 一次性验收服务：执行全部验收步骤后以退出码报告结果并退出。
// 顺序：
//  1) 规定场景断言：宽度 2 短脉冲及因果链；
//     延迟 3 的 NOT 在第 0/1 刻反转时撤销第 3 刻失效翻转；
//     正延迟反馈链振荡证据（稳定门 + 事件标识，可回放）；
//     容差复核：连续安全偏移区间、最接近零的首个短脉冲偏移、非法负刻度边界。
//  2) 代码测试（node --test）。
//  3) 页面构建（npm run build）。
//  4) 在可配置宿主端口启动服务，做 /health 与 /api/review 的 HTTP 冒烟，
//     并核对容差复核接口入口与内核的偏移排序、风险类型一致。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { simulate, sweepTolerance } from '../src/sim.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8091);
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('[1/4] 规定场景断言');

// 场景 A：宽度 2 短脉冲 + 因果链。
{
  const res = simulate({
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
  });
  const p = res.pulses.find((x) => x.gate === 'Y');
  ok('宽度为 2 的短脉冲被识别', p && p.width === 2, JSON.stringify(res.pulses));
  ok('短脉冲起止刻度正确', p && p.start === 5 && p.end === 7, `start=${p?.start} end=${p?.end}`);
  const chainRoot = p?.chain?.[0];
  ok('因果链回溯到外部边沿 t=2 a:1→0',
    chainRoot?.kind === 'edge' && chainRoot.t === 2 && chainRoot.input === 'a' && chainRoot.from === '1' && chainRoot.to === '0',
    JSON.stringify(p?.chain));
  ok('因果链含 Y 进入翻转事件标识', p?.chain?.some((c) => c.kind === 'fire' && c.gate === 'Y' && c.seq === p.enterSeq));
}

// 场景 B：延迟 3 的 NOT 在第 0、1 刻反转 → 第 3 刻失效翻转必须撤销。
{
  const res = simulate({
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 1, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  });
  ok('NOT 输出全程未翻转（失效翻转未落入轨迹）', res.timeline.every((s) => s.values.N === '1'));
  ok('不存在任何 FIRE 事件', !res.events.some((e) => e.action === 'FIRE'));
  const cancel = res.events.find((e) => e.action === 'CANCEL');
  ok('第 1 刻撤销第 3 刻到 0 的待发翻转',
    cancel && cancel.time === 1 && cancel.gate === 'N' && cancel.wasTo === '0',
    JSON.stringify(cancel));
  ok('结论为静稳且 N=1', res.status === 'STABLE' && res.stableValues.N === '1');
}

// 场景 C：正延迟反馈链振荡证据。
{
  const res = simulate({
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 0, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  });
  ok('检测到 OSCILLATING', res.status === 'OSCILLATING', res.status);
  const o = res.oscillation;
  ok('存在非空可回放循环与前缀', o && o.cycle.length > 0 && o.prefix.length >= 0);
  ok('循环按稳定门标识记录状态', o && o.cycle.every((f) => Array.isArray(Object.keys(f.values)) && Object.keys(f.values).every((k) => ['G', 'N'].includes(k))));
  ok('循环提供事件标识序列', o && o.events.length > 0 && o.events.every((e) => Number.isInteger(e.seq)));
  // 可回放性：循环起点与终点规范化状态签名重复（门值 + 相对待发事件）。
  const sig = o?.signature;
  ok('规范化状态签名非空，且含门值与相对待发事件',
    typeof sig === 'string' && sig.length > 0 && sig.includes('G=') && sig.includes('N='),
    String(sig));
  ok('振荡门包含反馈链上的门', o?.gates?.includes('G') || o?.gates?.includes('N'));
}

// 场景 D：容差复核 —— 连续安全偏移区间与最接近零的首个短脉冲偏移。
// NOT（延迟 3）监测 x：t=10 拉高、t=20 拉低。偏移 t=20 下降沿：
// k=-8 扰动短于延迟被撤销（安全）；k=-7 输出 [13,16) 宽 3 的临界短脉冲；k≥-6 脉冲更宽（安全）。
const tolCfg = {
  gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
  edges: [
    { time: 10, input: 'x', from: 0, to: 1 },
    { time: 20, input: 'x', from: 1, to: 0 },
  ],
  initialInputs: { x: '0' },
  monitors: ['N'],
};
const tolSpec = { edge: { time: 20, input: 'x' }, offsets: { from: -8, to: 4 } };
{
  const tol = sweepTolerance(tolCfg, tolSpec);
  ok('容差扫描成功', tol.ok === true, JSON.stringify(tol.errors));
  ok('偏移结果按偏移值升序稳定排列',
    tol.ok && tol.results.length === 13 && tol.results.every((r, i) => r.offset === -8 + i && r.edgeTime === 20 + r.offset));
  ok('连续安全偏移区间为 [-8,-8] 与 [-6,+4]',
    tol.ok && JSON.stringify(tol.safeIntervals) === JSON.stringify([{ from: -8, to: -8 }, { from: -6, to: 4 }]),
    JSON.stringify(tol.safeIntervals));
  ok('最接近零的风险偏移为首个短脉冲偏移 k=-7',
    tol.ok && tol.nearestRisk?.offset === -7 && tol.nearestRisk?.risk === 'PULSE' && tol.nearestByRisk?.PULSE === -7,
    JSON.stringify(tol.nearestRisk));
  const risk = tol.ok && tol.results.find((r) => r.offset === -7);
  ok('首个短脉冲偏移复用该次运行的脉冲证据（[13,16) 宽 3，非原始运行的宽 10）',
    risk && risk.evidence?.pulses?.[0]?.start === 13 && risk.evidence.pulses[0].end === 16 && risk.evidence.pulses[0].width === 3,
    JSON.stringify(risk?.evidence?.pulses));
}

// 场景 E：容差复核 —— 非法负刻度边界及其余明确错误；普通复核不受影响。
{
  const neg = sweepTolerance(tolCfg, { edge: { time: 10, input: 'x' }, offsets: { from: -11, to: -5 } });
  ok('偏移使边沿刻度为负：报 TOLERANCE_NEGATIVE_TICK 且无本轮结论',
    neg.ok === false && neg.errors.some((e) => e.code === 'TOLERANCE_NEGATIVE_TICK') && !neg.results,
    JSON.stringify(neg.errors));
  const edge0 = sweepTolerance(tolCfg, { edge: { time: 10, input: 'x' }, offsets: { from: -10, to: -10 } });
  ok('边界 k=-10（偏移后刻度恰为 0）合法', edge0.ok === true && edge0.results?.[0]?.edgeTime === 0);
  const noEdge = sweepTolerance(tolCfg, { edge: { time: 99, input: 'x' }, offsets: { from: 0, to: 1 } });
  ok('所选边沿不存在：报 TOLERANCE_EDGE_NOT_FOUND',
    noEdge.ok === false && noEdge.errors[0]?.code === 'TOLERANCE_EDGE_NOT_FOUND' && !noEdge.results);
  const badRange = sweepTolerance(tolCfg, { edge: { time: 10, input: 'x' }, offsets: { from: 1.5, to: 2 } });
  ok('范围非有限整数：报 TOLERANCE_RANGE_BAD',
    badRange.ok === false && badRange.errors[0]?.code === 'TOLERANCE_RANGE_BAD');
  const inverted = sweepTolerance(tolCfg, { edge: { time: 10, input: 'x' }, offsets: { from: 2, to: -2 } });
  ok('下界大于上界：报 TOLERANCE_RANGE_INVERTED',
    inverted.ok === false && inverted.errors[0]?.code === 'TOLERANCE_RANGE_INVERTED');
  const base = simulate(tolCfg);
  ok('容差错误后普通复核仍照常可用', base.ok === true && base.status === 'STABLE');
}

console.log('[2/4] 代码测试');
const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => resolve(code));
});
if (await run('npm', ['test', '--silent']) !== 0) { failures.push('npm test'); console.error('  ✗ 代码测试失败'); }
else console.log('  ✓ node --test 全部通过');

console.log('[3/4] 页面构建');
if (await run('npm', ['run', '--silent', 'build']) !== 0) { failures.push('npm run build'); console.error('  ✗ 页面构建失败'); }
else console.log('  ✓ web/dist 构建完成');

console.log(`[4/4] HTTP 冒烟（宿主 ${HOST}:${PORT}）`);
{
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, HOST, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', (d) => process.stderr.write(d));
  let healthy = false;
  let reviewOk = false;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://${HOST}:${PORT}/health`);
        if (r.ok) { const j = await r.json(); healthy = j.status === 'ok'; break; }
      } catch { /* 未就绪，继续等 */ }
      await sleep(100);
    }
    ok('GET /health 返回 200 status=ok', healthy);

    const pr = await fetch(`http://${HOST}:${PORT}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
        edges: [
          { time: 0, input: 'x', from: 0, to: 1 },
          { time: 1, input: 'x', from: 1, to: 0 },
        ],
        initialInputs: { x: '0' },
        monitors: ['N'],
      }),
    });
    const body = await pr.json();
    reviewOk = pr.status === 200 && body.ok && body.status === 'STABLE' && body.stableValues.N === '1';
    ok('POST /api/review 返回静稳结论（撤销场景）', reviewOk);

    // 容差复核接口入口：与内核直接调用同一输入，偏移排序与风险类型必须一致。
    const tr = await fetch(`http://${HOST}:${PORT}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...tolCfg, tolerance: tolSpec }),
    });
    const tj = await tr.json();
    const direct = sweepTolerance(tolCfg, tolSpec);
    ok('接口容差结论与内核一致（偏移排序）',
      tr.status === 200 && tj.ok === true && tj.tolerance?.ok === true &&
      JSON.stringify(tj.tolerance.results.map((r) => r.offset)) === JSON.stringify(direct.results.map((r) => r.offset)));
    ok('接口容差结论与内核一致（风险类型与安全区间）',
      tr.status === 200 &&
      JSON.stringify(tj.tolerance.results.map((r) => r.risk)) === JSON.stringify(direct.results.map((r) => r.risk)) &&
      JSON.stringify(tj.tolerance.safeIntervals) === JSON.stringify(direct.safeIntervals) &&
      JSON.stringify(tj.tolerance.nearestRisk) === JSON.stringify(direct.nearestRisk));

    // 容差错误只清除本轮容差结论：接口仍返回普通复核结论（200）。
    const br = await fetch(`http://${HOST}:${PORT}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...tolCfg, tolerance: { edge: { time: 10, input: 'x' }, offsets: { from: -11, to: 0 } } }),
    });
    const bj = await br.json();
    ok('容差错误不影响接口普通复核结论',
      br.status === 200 && bj.ok === true && bj.tolerance?.ok === false &&
      bj.tolerance.errors.some((e) => e.code === 'TOLERANCE_NEGATIVE_TICK') && !bj.tolerance.results,
      `HTTP ${br.status} ${JSON.stringify(bj.tolerance?.errors)}`);

    const page = await fetch(`http://${HOST}:${PORT}/`);
    const html = await page.text();
    ok('GET / 返回构建后的复核页面', page.ok && html.includes('冗余离散链路'));
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

if (failures.length) {
  console.error(`\n[verify] 验收失败（${failures.length} 项）：${failures.join('；')}`);
  process.exit(1);
}
console.log('\n[verify] 全部验收通过：场景断言、代码测试、页面构建、HTTP 冒烟。');
process.exit(0);
