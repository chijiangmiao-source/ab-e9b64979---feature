import { simulate, sweepTolerance } from '../src/sim.js';

const $ = (sel) => document.querySelector(sel);
const gateRows = $('#gateRows');
const edgeBody = $('#edgeTable tbody');
const DRAFT_KEY = 'inertial-review-draft-v1';

let gateSeq = 0;

function gateRowHtml(g = {}) {
  gateSeq += 1;
  const div = document.createElement('div');
  div.className = 'gate-row';
  div.innerHTML = `
    <input data-k="id" placeholder="门标识，如 Y1" value="${esc(g.id ?? '')}" />
    <select data-k="type">
      ${['NOT', 'AND', 'OR'].map((t) => `<option ${g.type === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <input data-k="delay" type="number" min="1" step="1" placeholder="延迟" value="${esc(g.delay ?? '')}" />
    <input data-k="inputs" placeholder="连线：A, input:en" value="${esc(Array.isArray(g.inputs) ? g.inputs.join(', ') : '')}" />
    <button type="button" class="ghost del" title="删除">✕</button>`;
  div.querySelector('.del').addEventListener('click', () => div.remove());
  return div;
}

function edgeRowHtml(e = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input data-k="time" type="number" min="0" step="1" value="${esc(e.time ?? '')}" style="width:80px" /></td>
    <td><input data-k="input" placeholder="输入名" value="${esc(e.input ?? '')}" /></td>
    <td><input data-k="from" type="text" maxlength="1" value="${esc(e.from ?? '')}" style="width:52px" /></td>
    <td><input data-k="to" type="text" maxlength="1" value="${esc(e.to ?? '')}" style="width:52px" /></td>
    <td><button type="button" class="ghost del">✕</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  return tr;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function collectConfig() {
  const gates = [...gateRows.children].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`);
    const inputs = get('inputs').value.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      id: get('id').value.trim(),
      type: get('type').value,
      delay: get('delay').value.trim(),
      inputs,
    };
  });
  const edges = [...edgeBody.children].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`);
    return { time: get('time').value.trim(), input: get('input').value.trim(), from: get('from').value.trim(), to: get('to').value.trim() };
  });
  const monitors = $('#monitors').value.split(',').map((s) => s.trim()).filter(Boolean);
  const initialInputs = {};
  $('#initialInputs').value.split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k) initialInputs[k] = v;
  });
  return { gates, edges, monitors, initialInputs };
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collectConfig())); } catch { /* ignore */ }
}
function loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  return d;
}

function hydrate(d) {
  gateRows.innerHTML = '';
  edgeBody.innerHTML = '';
  (d?.gates?.length ? d.gates : [{ id: 'Y', type: 'NOT', delay: 3, inputs: 'input:x' }]).forEach((g) => gateRows.appendChild(gateRowHtml(g)));
  (d?.edges || []).forEach((e) => edgeBody.appendChild(edgeRowHtml(e)));
  if (!edgeBody.children.length) {
    edgeBody.appendChild(edgeRowHtml({ time: 0, input: 'x', from: 0, to: 1 }));
    edgeBody.appendChild(edgeRowHtml({ time: 1, input: 'x', from: 1, to: 0 }));
  }
  $('#monitors').value = (d?.monitors || []).join(', ');
  $('#initialInputs').value = Object.entries(d?.initialInputs || {}).map(([k, v]) => `${k}=${v}`).join(', ');
}

function chainHtml(chain) {
  return chain.map((c) => {
    if (c.kind === 'edge') return `边沿 t=${c.t} ${esc(c.input)}:${c.from}→${c.to}`;
    if (c.kind === 'fire') return `#${c.seq} ${esc(c.gate)}→${c.to}@t${c.t}`;
    if (c.kind === 'powerup') return '上电初值';
    return JSON.stringify(c);
  }).join(' &nbsp;←&nbsp; ');
}

function framesTable(frames, monitors, title) {
  if (!frames.length) return `<p class="kv">${title}：空</p>`;
  const head = `<tr><th>相对刻</th><th>刻度</th>${monitors.map((m) => `<th>${esc(m)}</th>`).join('')}<th>本刻事件</th></tr>`;
  const rows = frames.map((f) => {
    const evs = [
      ...f.external.map((e) => `边沿 ${esc(e.input)} ${e.from}→${e.to}`),
      ...f.fired.map((e) => `#${e.seq} ${esc(e.gate)}→${e.to} 生效`),
      ...f.cancelled.map((e) => `#${e.seq} ${esc(e.gate)}→${esc(e.wasTo ?? '')} 撤销`),
    ].join('；') || '—';
    return `<tr><td>${f.relative}</td><td>${f.t}</td>${monitors.map((m) => `<td class="v${f.values[m]}">${f.values[m]}</td>`).join('')}<td style="text-align:left">${evs}</td></tr>`;
  }).join('');
  return `<div class="sec-title">${title}</div><table class="out"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function pulsesTable(pulses) {
  let html = `<table class="out"><thead><tr><th>输出</th><th>电平</th><th>起</th><th>止</th><th>宽度</th><th>门惯性延迟</th><th>进入/退出事件</th><th style="text-align:left">因果事件链</th></tr></thead><tbody>`;
  html += pulses.map((p) => `<tr class="pulse-row">
    <td>${esc(p.gate)}</td><td class="v${p.level}">${p.level}</td><td>${p.start}</td><td>${p.end}</td>
    <td><b>${p.width}</b> 刻</td><td>${p.inertialDelay}</td><td>#${p.enterSeq} → #${p.exitSeq}</td>
    <td style="text-align:left"><div class="chain">${chainHtml(p.chain)}</div></td></tr>`).join('');
  return `${html}</tbody></table>`;
}

function render(result) {
  const box = $('#result');
  box.classList.remove('hidden');
  if (!result.ok) {
    box.innerHTML = `<h2><span class="badge err">校验失败 · 已清除旧结论</span></h2>
      <ul class="errors">${result.errors.map((e) => `<li>[${e.code}] ${esc(e.message)}</li>`).join('')}</ul>`;
    return;
  }
  const stableLine = Object.entries(result.stableValues).map(([k, v]) => `${esc(k)}=<b>${v}</b>`).join('，');
  const badgeCls = result.status === 'OSCILLATING' ? 'osc' : result.status === 'UNRESOLVED' ? 'err' : 'stable';
  const badgeText = result.status === 'OSCILLATING' ? '持续振荡' : result.status === 'UNRESOLVED' ? '观察窗口内未收敛' : '静稳';
  let html = `<h2><span class="badge ${badgeCls}">${badgeText}</span></h2>`;
  html += `<p class="kv">外部边沿结束刻度：${result.endTime} ｜ 规范化配置哈希：<code>${result.normalized.hash}</code> ｜ 静稳输出：${stableLine}</p>`;

  if (result.pulses.length) {
    html += `<div class="sec-title">短脉冲（${result.pulses.length} 个）</div>${pulsesTable(result.pulses)}`;
  } else {
    html += `<p class="kv">未发现短脉冲。</p>`;
  }

  if (result.status === 'OSCILLATING') {
    const o = result.oscillation;
    html += `<div class="sec-title">振荡证据</div>
      <p class="kv">循环区间：t=${o.cycleStart}…${o.cycleEnd - 1}（周期 ${o.period} 刻）｜
      振荡门：${o.gates.map(esc).join(', ') || '—'} ｜
      循环事件标识：${o.events.map((e) => `#${e.seq}@${e.relative}`).join(', ')}</p>
      <p class="kv">状态签名（门值与相对待发事件）重复：<code>${esc(o.signature)}</code></p>`;
    html += framesTable(o.prefix, result.monitors, '振荡前缀（边沿结束后到进入循环）');
    html += framesTable(o.cycle, result.monitors, '可回放循环（按稳定门顺序与事件标识）');
  } else {
    const tail = result.timeline.filter((s) => s.t >= result.endTime);
    html += framesTable(tail.map((s) => ({ ...s, relative: s.t - result.endTime })), result.monitors, '边沿结束后的轨迹');
    if (result.pendingAfterEnd.length) {
      html += `<p class="kv">结束后仍有待发事件：${result.pendingAfterEnd.map((p) => `${esc(p.gate)}→${p.to}@+${p.relativeToEnd}`).join('，')}（均在生效前得到确认，未影响静稳结论）</p>`;
    }
  }
  box.innerHTML = html;
}

const RISK_LABEL = { PULSE: '短脉冲', OSCILLATING: '振荡', UNRESOLVED: '未决', INVALID: '配置无效' };
const fmtK = (k) => (k > 0 ? `+${k}` : `${k}`);

// 从边沿表刷新可选边沿（与接口一致：按 刻度+输入名 定位）。
function refreshTolEdges() {
  const sel = $('#tolEdge');
  const prev = sel.value;
  const edges = [...edgeBody.children].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`).value.trim();
    return { time: get('time'), input: get('input'), from: get('from'), to: get('to') };
  }).filter((e) => e.input && e.time !== '' && Number.isInteger(Number(e.time)));
  sel.innerHTML = edges.map((e) => {
    const v = esc(JSON.stringify({ time: Number(e.time), input: e.input }));
    return `<option value="${v}">t=${esc(e.time)} · ${esc(e.input)}：${esc(e.from)}→${esc(e.to)}</option>`;
  }).join('') || '<option value="">（暂无边沿，请先在第 2 步录入）</option>';
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function resetTolerance() {
  $('#tolResult').innerHTML = '';
  refreshTolEdges();
}

// 风险项证据：一律取自该偏移那次运行（脉冲时段 / 振荡循环），不回退到原始运行。
function evidenceHtml(r, monitors) {
  let h = '';
  if (r.evidence?.pulses?.length) {
    h += `<div class="sec-title">该次运行短脉冲（k=${fmtK(r.offset)}，边沿刻度 ${r.edgeTime}）</div>${pulsesTable(r.evidence.pulses)}`;
  }
  if (r.evidence?.oscillation) {
    const o = r.evidence.oscillation;
    h += `<p class="kv">该次运行振荡：循环区间 t=${o.cycleStart}…${o.cycleEnd - 1}（周期 ${o.period} 刻）｜
      振荡门：${o.gates.map(esc).join(', ') || '—'} ｜ 循环事件标识：${o.events.map((e) => `#${e.seq}@${e.relative}`).join(', ') || '—'}<br/>
      状态签名：<code>${esc(o.signature)}</code></p>`;
    h += framesTable(o.prefix, monitors, '振荡前缀（该次运行）');
    h += framesTable(o.cycle, monitors, '可回放循环（该次运行）');
  }
  if (r.evidence?.unresolved) {
    const u = r.evidence.unresolved;
    h += `<p class="kv">该次运行观察窗口耗尽（stopTick=${u.stopTick}）仍未收敛` +
      (u.pendingAfterEnd?.length
        ? `；结束后仍有待发事件：${u.pendingAfterEnd.map((p) => `${esc(p.gate)}→${p.to}@+${p.relativeToEnd}`).join('，')}`
        : '') + `</p>`;
  }
  if (r.evidence?.errors?.length) {
    h += `<ul class="errors">${r.evidence.errors.map((e) => `<li>[${e.code}] ${esc(e.message)}</li>`).join('')}</ul>`;
  }
  return h || '<p class="kv">无证据。</p>';
}

function renderTolerance(res) {
  const box = $('#tolResult');
  if (!res.ok) {
    // 明确说明错误并清除本轮容差结论；上方普通复核结论不受影响。
    box.innerHTML = `<h3 class="tol-head"><span class="badge err">容差复核未执行 · 本轮容差结论已清除</span></h3>
      <ul class="errors">${res.errors.map((e) => `<li>[${e.code}] ${esc(e.message)}</li>`).join('')}</ul>`;
    return;
  }
  const c = res.counts;
  const fmtInterval = (iv) => (iv.from === iv.to ? `[${fmtK(iv.from)}]` : `[${fmtK(iv.from)}, ${fmtK(iv.to)}]`);
  const safeText = res.safeIntervals.length ? res.safeIntervals.map(fmtInterval).join('、') : '无';
  const near = res.nearestRisk;
  const nearText = near
    ? `k=${fmtK(near.offset)}（${RISK_LABEL[near.risk]}，偏移后边沿刻度 ${near.edgeTime}）`
    : '无（扫描范围内全部静稳）';
  const byKind = ['PULSE', 'OSCILLATING', 'UNRESOLVED']
    .map((k) => `${RISK_LABEL[k]}：${res.nearestByRisk[k] !== undefined ? `k=${fmtK(res.nearestByRisk[k])}` : '无'}`).join(' ｜ ');

  let html = `<h3 class="tol-head"><span class="badge ${near ? 'osc' : 'stable'}">容差复核完成</span></h3>
    <p class="kv">边沿 t=${res.edge.time} ${esc(res.edge.input)}（${res.edge.from}→${res.edge.to}）｜
    偏移范围 [${fmtK(res.offsets.from)}, ${fmtK(res.offsets.to)}] 共 ${c.total} 个：
    静稳 ${c.safe || 0} · 短脉冲 ${c.PULSE || 0} · 振荡 ${c.OSCILLATING || 0} · 未决 ${c.UNRESOLVED || 0}${c.INVALID ? ` · 无效 ${c.INVALID}` : ''}</p>
    <p class="kv"><b>连续安全偏移区间：</b>${safeText}<br/>
    <b>最接近零的风险偏移：</b>${nearText}<br/>
    <b>各风险类型最近偏移：</b>${byKind}</p>`;
  html += `<table class="out"><thead><tr><th>偏移 k</th><th>边沿刻度</th><th>结论</th><th style="text-align:left">该次运行证据</th></tr></thead><tbody>`;
  for (const r of res.results) {
    const label = r.risk ? RISK_LABEL[r.risk] : '静稳';
    const cls = r.risk === 'PULSE' ? 'pulse-row' : r.risk === 'OSCILLATING' ? 'osc-row' : r.risk ? 'err-row' : '';
    const detail = r.risk
      ? `<details><summary>展开该次运行证据</summary>${evidenceHtml(r, res.monitors)}</details>`
      : '—';
    html += `<tr class="${cls}"><td>${fmtK(r.offset)}</td><td>${r.edgeTime}</td><td>${label}</td><td style="text-align:left">${detail}</td></tr>`;
  }
  box.innerHTML = `${html}</tbody></table>`;
}

$('#tolRun').addEventListener('click', () => {
  refreshTolEdges();
  let edge = null;
  try { edge = JSON.parse($('#tolEdge').value); } catch { edge = null; }
  const spec = { edge, offsets: { from: $('#tolFrom').value, to: $('#tolTo').value } };
  try {
    renderTolerance(sweepTolerance(collectConfig(), spec));
  } catch (err) {
    renderTolerance({ ok: false, errors: [{ code: 'INTERNAL', message: String(err?.stack || err) }] });
  }
});

$('#addGate').addEventListener('click', () => gateRows.appendChild(gateRowHtml({ type: 'AND', delay: 1 })));
$('#addEdge').addEventListener('click', () => edgeBody.appendChild(edgeRowHtml()));
$('#clear').addEventListener('click', () => {
  localStorage.removeItem(DRAFT_KEY);
  gateRows.innerHTML = '';
  edgeBody.innerHTML = '';
  $('#monitors').value = '';
  $('#initialInputs').value = '';
  $('#result').classList.add('hidden');
  hydrate(null);
  resetTolerance();
  $('#draftNote').textContent = '草稿已清空。';
});
$('#submit').addEventListener('click', () => {
  saveDraft();
  $('#draftNote').textContent = '';
  resetTolerance(); // 新一轮复核：清除上一轮容差结论并按当前边沿表刷新可选项
  const config = collectConfig();
  try {
    render(simulate(config));
  } catch (err) {
    render({ ok: false, errors: [{ code: 'INTERNAL', message: String(err?.stack || err) }] });
  }
});

hydrate(loadDraft());
refreshTolEdges();
