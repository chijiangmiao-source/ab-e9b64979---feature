import { simulate, runTolerance } from '../src/sim.js';

const $ = (sel) => document.querySelector(sel);
const gateRows = $('#gateRows');
const edgeBody = $('#edgeTable tbody');
const tolEdge = $('#tolEdge');
const DRAFT_KEY = 'inertial-review-draft-v1';

let gateSeq = 0;
// 最近一次通过校验的普通复核的已录入边沿（规范化、有序）与监控输出，供容差复核选择。
let lastEdges = [];
let lastMonitors = [];

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
    html += `<div class="sec-title">短脉冲（${result.pulses.length} 个）</div>
      <table class="out"><thead><tr><th>输出</th><th>电平</th><th>起</th><th>止</th><th>宽度</th><th>门惯性延迟</th><th>进入/退出事件</th><th style="text-align:left">因果事件链</th></tr></thead><tbody>`;
    html += result.pulses.map((p) => `<tr class="pulse-row">
      <td>${esc(p.gate)}</td><td class="v${p.level}">${p.level}</td><td>${p.start}</td><td>${p.end}</td>
      <td><b>${p.width}</b> 刻</td><td>${p.inertialDelay}</td><td>#${p.enterSeq} → #${p.exitSeq}</td>
      <td style="text-align:left"><div class="chain">${chainHtml(p.chain)}</div></td></tr>`).join('');
    html += `</tbody></table>`;
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
  lastEdges = [];
  lastMonitors = [];
  populateTolEdges();
  $('#tolLower').value = '';
  $('#tolUpper').value = '';
  clearTolResult('草稿已清空。');
  $('#draftNote').textContent = '草稿已清空。';
});
$('#submit').addEventListener('click', () => {
  saveDraft();
  $('#draftNote').textContent = '';
  const config = collectConfig();
  try {
    const result = simulate(config);
    render(result);
    if (result.ok) {
      // 用规范化后的已录入边沿填充容差选择，保证与接口同一排序与标识。
      lastEdges = result.normalized.normalized.edges.map((e) => ({ ...e }));
      lastMonitors = [...result.monitors];
      populateTolEdges();
    } else {
      lastEdges = [];
      lastMonitors = [];
      populateTolEdges();
      clearTolResult('普通复核未通过，容差复核不可用。');
    }
  } catch (err) {
    render({ ok: false, errors: [{ code: 'INTERNAL', message: String(err?.stack || err) }] });
  }
});

function populateTolEdges() {
  tolEdge.innerHTML = '';
  if (!lastEdges.length) {
    tolEdge.innerHTML = '<option value="">（请先提交普通复核以载入边沿）</option>';
    return;
  }
  for (const e of lastEdges) {
    const opt = document.createElement('option');
    opt.value = `${e.time}|${e.input}`;
    opt.textContent = `t=${e.time}　${e.input}: ${e.from}→${e.to}`;
    tolEdge.appendChild(opt);
  }
}

function clearTolResult(note) {
  $('#tolResult').classList.add('hidden');
  $('#tolResult').innerHTML = '';
  $('#tolNote').textContent = note || '';
}

const KIND_LABEL = {
  STABLE: '静稳',
  GLITCH: '短脉冲',
  OSCILLATING: '振荡',
  UNRESOLVED: '未决',
  INVALID: '非法',
};

function renderTolerance(result) {
  const box = $('#tolResult');
  box.classList.remove('hidden');
  if (!result.ok) {
    // 整体非法：明确列出错误并清除本轮容差结论。
    box.innerHTML = `<h2><span class="badge err">容差参数非法 · 已清除本轮容差结论</span></h2>
      <p class="kv">原始配置与普通复核结论保持不变。</p>
      <ul class="errors">${result.errors.map((e) => `<li>[${e.code}] ${esc(e.message)}</li>`).join('')}</ul>`;
    return;
  }

  const req = result.request;
  let html = `<h2><span class="badge stable">容差复核完成</span></h2>`;
  html += `<p class="kv">所选边沿：<b>t=${req.edge.time} ${esc(req.edge.input)} ${req.edge.from}→${req.edge.to}</b>
    ｜偏移区间：[${req.lower}, ${req.upper}]（平移后刻度为原刻度 + 偏移）</p>`;

  const c = result.counts;
  html += `<div class="tol-badges">
    <span class="pill stable">静稳 <span class="n">${c.STABLE}</span></span>
    <span class="pill glitch">短脉冲 <span class="n">${c.GLITCH}</span></span>
    <span class="pill osc">振荡 <span class="n">${c.OSCILLATING}</span></span>
    <span class="pill unresolved">未决 <span class="n">${c.UNRESOLVED}</span></span>
    <span class="pill invalid">逐点非法 <span class="n">${c.INVALID}</span></span>
  </div>`;

  const safeText = result.safeRanges.length
    ? result.safeRanges.map((r) => (r.lower === r.upper ? `[${r.lower}]` : `[${r.lower}, ${r.upper}]`)).join('，')
    : '无';
  if (result.nearestRisk) {
    const n = result.nearestRisk;
    html += `<p class="kv">连续安全偏移区间：<b style="color:var(--ok)">${safeText}</b>
      ｜最接近零的风险偏移：<b style="color:var(--warn)">${n.offset >= 0 ? '+' : ''}${n.offset}</b>
      （平移后刻度 ${n.edgeTime}，类型：${KIND_LABEL[n.kind]}）</p>`;
  } else {
    const tail = c.INVALID > 0
      ? '区间内无短脉冲/振荡/未决风险（另有逐点非法偏移，见下方说明）。'
      : '区间内无短脉冲/振荡/未决风险，全部偏移静稳。';
    html += `<p class="kv">连续安全偏移区间：<b style="color:var(--ok)">${safeText}</b>
      ｜${tail}</p>`;
  }

  // 偏移轨道：逐偏移稳定展示。
  html += '<div class="tol-track">';
  for (const p of result.results) {
    const nearest = result.nearestRisk && result.nearestRisk.offset === p.offset && p.kind !== 'STABLE' && p.kind !== 'INVALID';
    html += `<div class="tick-cell ${p.kind.toLowerCase()}${nearest ? ' nearest' : ''}" title="偏移 ${p.offset}：${KIND_LABEL[p.kind]}">
      <span class="o">${p.offset >= 0 ? '+' : ''}${p.offset}</span>
      <span class="m">${KIND_LABEL[p.kind]}</span></div>`;
  }
  html += '</div>';

  // 风险项：展开后复用该次运行（该偏移）的证据，而非原始运行证据。
  const risks = result.results.filter((p) => ['GLITCH', 'OSCILLATING', 'UNRESOLVED'].includes(p.kind));
  if (risks.length) {
    html += `<div class="sec-title">风险偏移明细（证据取自该偏移运行）</div>`;
    for (const p of risks) {
      const head = `偏移 ${p.offset >= 0 ? '+' : ''}${p.offset}（边沿→刻度 ${p.edgeTime}）：${KIND_LABEL[p.kind]}`;
      html += `<details class="risk-item" ${result.nearestRisk && result.nearestRisk.offset === p.offset ? 'open' : ''}>
        <summary>${head}</summary><div class="risk-body">${riskEvidenceHtml(p)}</div></details>`;
    }
  }

  const invalids = result.results.filter((p) => p.kind === 'INVALID');
  if (invalids.length) {
    html += `<p class="kv" style="color:var(--bad)">以下偏移使配置无法通过既有校验（不计入安全区间，也不改变原始配置）：
      ${invalids.map((p) => `偏移 ${p.offset >= 0 ? '+' : ''}${p.offset}（${(p.errors || []).map((e) => esc(e.message)).join('；') || '配置非法'}）`).join('；')}</p>`;
  }

  box.innerHTML = html;
}

function riskEvidenceHtml(p) {
  if (p.kind === 'GLITCH') {
    if (!p.pulses || !p.pulses.length) return '<p class="kv">该次运行未附带脉冲证据。</p>';
    return `<table class="out"><thead><tr><th>输出</th><th>电平</th><th>起</th><th>止</th><th>宽度</th><th>门延迟</th><th style="text-align:left">该次运行因果链</th></tr></thead><tbody>` +
      p.pulses.map((pu) => `<tr class="pulse-row"><td>${esc(pu.gate)}</td><td class="v${pu.level}">${pu.level}</td>
        <td>${pu.start}</td><td>${pu.end}</td><td><b>${pu.width}</b> 刻</td><td>${pu.inertialDelay}</td>
        <td style="text-align:left"><div class="chain">${chainHtml(pu.chain)}</div></td></tr>`).join('') +
      `</tbody></table>`;
  }
  if (p.kind === 'OSCILLATING') {
    const o = p.oscillation;
    if (!o) return '<p class="kv">该次运行未附带振荡证据。</p>';
    let h = `<p class="kv">循环区间：t=${o.cycleStart}…${o.cycleEnd - 1}（周期 ${o.period} 刻）｜
      振荡门：${o.gates.map(esc).join(', ') || '—'} ｜
      循环事件标识：${o.events.map((e) => `#${e.seq}@${e.relative}`).join(', ')}</p>
      <p class="kv">该次运行状态签名重复：<code>${esc(o.signature)}</code></p>`;
    h += framesTable(o.cycle, lastMonitors, '该偏移运行的可回放循环');
    return h;
  }
  // UNRESOLVED
  return `<p class="kv">该偏移运行在观察窗口耗尽时仍有待发事件、未得到静稳或振荡结论（未决）。</p>
    <p class="kv">静稳输出（当前刻）：${Object.entries(p.stableValues || {}).map(([k, v]) => `${esc(k)}=${v}`).join('，') || '—'}</p>`;
}

$('#tolSubmit').addEventListener('click', () => {
  $('#tolNote').textContent = '';
  if (!lastEdges.length) { clearTolResult('请先成功完成一次普通复核，再运行容差复核。'); return; }
  const sel = tolEdge.value;
  if (!sel) { renderTolerance({ ok: false, errors: [{ code: 'TOL_EDGE_UNKNOWN', message: '请选择一条已录入的外部边沿。' }] }); return; }
  const sep = sel.indexOf('|');
  const edgeTime = Number(sel.slice(0, sep));
  const edgeInput = sel.slice(sep + 1);
  const lowerRaw = $('#tolLower').value.trim();
  const upperRaw = $('#tolUpper').value.trim();
  const parseInt10 = (s) => {
    if (s === '' || !/^[+-]?\d+$/.test(s)) return NaN;
    return Number(s);
  };
  const lower = parseInt10(lowerRaw);
  const upper = parseInt10(upperRaw);
  if (!Number.isInteger(lower) || !Number.isInteger(upper)) {
    renderTolerance({ ok: false, errors: [{ code: 'TOL_RANGE_BAD', message: `允许前后偏移的范围必须是有限整数（收到下界“${lowerRaw}”、上界“${upperRaw}”）。` }] });
    return;
  }
  const config = collectConfig();
  try {
    const result = runTolerance(config, { edgeTime, edgeInput, lower, upper });
    renderTolerance(result);
  } catch (err) {
    renderTolerance({ ok: false, errors: [{ code: 'INTERNAL', message: String(err?.stack || err) }] });
  }
});

hydrate(loadDraft());
