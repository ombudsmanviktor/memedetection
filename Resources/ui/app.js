/* ═══════════════════════════════════════════════════════════════════════════
   MemeDetection — interface
   A lógica de ligação linha↔imagem, rótulos e CSV fica em core.js (MDCore),
   compartilhada com o modo CLI. Aqui ficam a interface e a ponte com o Swift.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => n.toLocaleString('pt-BR');
const fmtDec = (x, d = 2) => x.toFixed(d).replace('.', ',');
const fmtPct = x => x === null ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%';
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 100 ? 0 : 1).replace('.', ',') + ' ' + u[i];
}
function showBanner(id, html) { const el = $(id); el.innerHTML = html; el.classList.toggle('visible', !!html); }
const csvStem = () => state.csv.name.replace(/\.[^.]+$/, '');
const joinPath = (a, b) => a.replace(/\/+$/, '') + '/' + b;

/* ── Ponte com o app nativo ──────────────────────────────────────────────
   No app: window.webkit.messageHandlers.md (Swift). Em ?mock=1 (navegador),
   uma simulação para testar a interface sem o modelo.                     */
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.md);
const MOCK = !NATIVE && /[?&]mock=1\b/.test(location.search);

const nativeBridge = {
  call: (cmd, args = {}) => window.webkit.messageHandlers.md.postMessage(Object.assign({ cmd }, args)),
  thumb: (root, rel, s = 120) => `memedetection://thumb/?s=${s}&path=${encodeURIComponent(joinPath(root, rel))}`
};

const mockBridge = (() => {
  const urls = new Map();   // caminho relativo → object URL
  const pick = (attrs) => new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; Object.assign(inp, attrs);
    inp.addEventListener('change', () => resolve(inp.files));
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
  const fromCSV = async f => ({ path: '/simulado/' + f.name, name: f.name, dir: '/simulado', size: f.size, text: await f.text() });
  const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
  return {
    fromCSV,
    thumb: (root, rel) => urls.get(rel) || '',
    async call(cmd, a = {}) {
      switch (cmd) {
        case 'appInfo': return { version: MDCore.VERSION, executable: '/Applications/MemeDetection.app/Contents/MacOS/MemeDetection', macOS: 'simulado' };
        case 'modelStatus': return { ready: true, exactLogit: true, simulated: true };
        case 'pickCSV': { const fs = await pick({ accept: '.csv,.tsv,.txt' }); return fs && fs[0] ? fromCSV(fs[0]) : null; }
        case 'pickFolder': {
          const fs = await pick({ webkitdirectory: true, multiple: true });
          if (!fs || !fs.length) return null;
          const top = fs[0].webkitRelativePath.split('/')[0];
          urls.forEach(u => URL.revokeObjectURL(u)); urls.clear();
          const files = [];
          for (const f of fs) {
            const rel = f.webkitRelativePath.split('/').slice(1).join('/');
            if (!rel || rel.split('/').some(p => p.startsWith('.'))) continue;
            files.push({ name: rel, size: f.size });
            if (/^image\//.test(f.type)) urls.set(rel, URL.createObjectURL(f));
          }
          return { path: '/simulado/' + top, name: top, files };
        }
        case 'classify': {
          await new Promise(r => setTimeout(r, 60));
          const out = {};
          for (const f of a.files) {
            if (!MDCore.IMG_EXT.test(f)) { out[f] = { error: 'não é imagem (.' + f.split('.').pop() + ')' }; continue; }
            const z = /meme/i.test(f) ? 6 + hash(f) * 20 : (hash(f) - 0.7) * 40;
            out[f] = { p: 1 / (1 + Math.exp(-z)), logit: z };
          }
          return out;
        }
        case 'copyMemeImages': {
          for (let i = 1; i <= a.files.length; i++) {
            if (i % 25 === 0 || i === a.files.length) { window.mdNativeEvent('copy', { done: i, total: a.files.length }); await new Promise(r => setTimeout(r, 20)); }
          }
          return { path: '/simulado/' + (a.name || 'memes'), copied: a.files.length, failed: [] };
        }
        case 'saveCSV': case 'overwriteCSV': {
          if (cmd === 'overwriteCSV' && !confirm(a.detail)) return null;
          const name = a.name || a.path.split('/').pop();
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([(a.bom ? '\uFEFF' : '') + a.text], { type: 'text/csv;charset=utf-8' }));
          link.download = name; document.body.appendChild(link); link.click(); link.remove();
          return { path: 'Downloads/' + name };
        }
        case 'copy': await navigator.clipboard.writeText(a.text); return true;
        case 'openURL': window.open(a.url, '_blank', 'noopener'); return true;
        default: return true;
      }
    }
  };
})();

const bridge = NATIVE ? nativeBridge : mockBridge;
const call = (cmd, args) => bridge.call(cmd, args);

/* ── Estado ─────────────────────────────────────────────────────────────── */
const state = {
  app: null,
  csv: null,        // {path, name, dir, size}
  table: null,      // MDCore.parseCSV
  folder: null,     // {path, name, files}
  idx: null,        // MDCore.indexFiles
  links: null,      // MDCore.analyzeLinks
  link: null,       // {col, mode}
  plan: null,       // MDCore.planRun
  truthCol: -1,
  threshold: 0.5,
  cache: new Map(), // arquivo → {p, logit, error}, reaproveitado entre análises da mesma pasta
  cacheRoot: '',
  run: null,
  rowRes: null
};

/* ── Navegação ──────────────────────────────────────────────────────────── */
function goStep(n) {
  ['step-files', 'step-config', 'step-run'].forEach((id, i) => $(id).classList.toggle('active', i === n - 1));
  for (let i = 1; i <= 3; i++) {
    $('s-dot-' + i).classList.toggle('active', i === n);
    $('s-dot-' + i).classList.toggle('done', i < n);
  }
  $('s-line-1').classList.toggle('done', n > 1);
  $('s-line-2').classList.toggle('done', n > 2);
  window.scrollTo({ top: 0 });
}

/* ── Passo 1: arquivos ──────────────────────────────────────────────────── */
function setCSV(res) {
  showBanner('error-files', '');
  if (!res) return;
  const table = MDCore.parseCSV(res.text, res.bom);
  if (table.error) { showBanner('error-files', esc(table.error)); return; }
  state.csv = { path: res.path, name: res.name, dir: res.dir, size: res.size };
  state.table = table;
  $('csv-name').textContent = res.name;
  $('csv-name').title = res.path;
  $('csv-meta').textContent = `${fmtInt(table.rows.length)} linhas · ${table.header.length} colunas · ${fmtBytes(res.size || 0)}`;
  $('card-csv').classList.add('visible');
  $('dz-csv').classList.add('loaded');
  refreshStep1();
}

function setFolder(res) {
  showBanner('error-files', '');
  if (!res) return;
  state.folder = res;
  state.idx = MDCore.indexFiles(res.files);
  if (state.cacheRoot !== res.path) { state.cache = new Map(); state.cacheRoot = res.path; }
  const imgs = res.files.filter(f => MDCore.IMG_EXT.test(f.name)).length;
  const exts = {};
  res.files.forEach(f => { const e = (f.name.match(/\.([^.\/]+)$/) || [, '?'])[1].toLowerCase(); exts[e] = (exts[e] || 0) + 1; });
  const top = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${fmtInt(n)} .${e}`).join(' · ');
  $('folder-name').textContent = res.name;
  $('folder-name').title = res.path;
  $('folder-meta').textContent = `${fmtInt(imgs)} imagens de ${fmtInt(res.files.length)} arquivos${top ? ' · ' + top : ''}`;
  $('card-folder').classList.add('visible');
  $('dz-folder').classList.add('loaded');
  if (!res.files.length) showBanner('error-files', 'A pasta escolhida está vazia.');
  refreshStep1();
}

function refreshStep1() {
  const ready = state.table && state.folder && state.folder.files.length;
  let hint = '';
  if (!state.table) hint = 'Escolha o CSV.';
  else if (!state.folder) hint = 'Escolha a pasta de imagens.';
  if (ready) {
    state.links = MDCore.analyzeLinks(state.table, state.idx);
    if (!state.links.best) {
      hint = '';
      showBanner('error-files', 'Nenhuma coluna do CSV corresponde aos arquivos da pasta: nenhum valor é igual ao nome de um arquivo (<code>1234.jpg</code>) nem ao início dele (<code>1234_1.jpg</code>). Confira se escolheu a pasta certa.');
    }
  }
  $('btn-continue-1').disabled = !(ready && state.links && state.links.best);
  $('continue-hint').textContent = hint;
}

async function pickCSV() { try { setCSV(await call('pickCSV')); } catch (e) { showBanner('error-files', esc(e.message || e)); } }
async function pickFolder() { try { setFolder(await call('pickFolder')); } catch (e) { showBanner('error-files', esc(e.message || e)); } }

// Eventos nativos (arrastar do Finder)
window.mdNativeEvent = async (type, data) => {
  if (type === 'copy') {
    const el = $('copy-progress');
    el.style.display = '';
    el.textContent = `Copiando… ${fmtInt(data.done)} de ${fmtInt(data.total)}`;
    return;
  }
  if (type === 'drag') {
    ['dz-csv', 'dz-folder'].forEach(id => $(id).classList.toggle('drag-over', !!data.on));
  } else if (type === 'drop') {
    ['dz-csv', 'dz-folder'].forEach(id => $(id).classList.remove('drag-over'));
    if (!$('step-files').classList.contains('active')) goStep(1);
    try {
      if (data.isDir) setFolder(await call('openFolder', { path: data.path }));
      else setCSV(await call('openCSV', { path: data.path }));
    } catch (e) { showBanner('error-files', esc(e.message || e)); }
  }
};

/* ── Passo 2: configuração ──────────────────────────────────────────────── */
function setupConfig() {
  const best = state.links.best;
  if (!state.link || !state.links.stats.some(s => s.col === state.link.col && s.hits > 0)) state.link = { col: best.col, mode: best.mode };
  renderLinkList();
  const opts = ['<option value="-1">Nenhuma</option>'].concat(state.table.header.map((h, i) =>
    `<option value="${i}" ${i === state.truthCol ? 'selected' : ''}>${esc(h || '(sem nome)')}</option>`));
  $('truth-col').innerHTML = opts.join('');
  if (state.truthCol < 0) {   // sugere uma coluna com nome de rótulo
    const g = state.table.header.findIndex(h => /^(rotulo|rótulo|label|classe|class|verdade|gold|ground.?truth|is_?meme|meme)$/i.test(h.trim()));
    if (g >= 0 && truthCount(g) > 0) { state.truthCol = g; $('truth-col').value = String(g); }
  }
  recompute();
}

function renderLinkList() {
  const st = state.links.stats;
  const withHits = st.filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits);
  const without = st.filter(s => s.hits === 0);
  const modeLbl = { file: 'nome do arquivo', id: 'ID → arquivo' };
  const row = s => {
    const checked = state.link && s.col === state.link.col ? 'checked' : '';
    const label = s.col === MDCore.ROWNUM ? '<em>Número da linha</em>' : (s.label.trim() === '' ? '<em>(sem nome)</em>' : esc(s.label));
    const pill = s.hits
      ? `<span class="pill mode">${modeLbl[s.mode]}</span><span class="pill media">${s.estimated ? '≈' : ''}${fmtInt(s.hits)} linhas</span>`
      : '<span class="pill">sem imagem</span>';
    return `<label class="check-row ${s.hits ? '' : 'nourl'}"><input type="radio" name="link" data-col="${esc(String(s.col))}" data-mode="${s.mode}" ${checked} ${s.hits ? '' : 'disabled'}><span class="check-label" title="${esc(s.label)}">${label}</span>${pill}</label>`;
  };
  let html = withHits.map(row).join('');
  if (without.length) html += `<div class="list-sep">Sem correspondência na pasta (${without.length})</div>` + without.map(row).join('');
  $('link-list').innerHTML = html;
}

function truthCount(col) {
  return state.table.rows.reduce((n, r) => n + (MDCore.truthOf(r[col]) ? 1 : 0), 0);
}

function recompute() {
  const { table, idx, link } = state;
  state.plan = MDCore.planRun(table, idx, link.col, link.mode);
  state.threshold = clampThr(parseFloat($('threshold').value));
  const p = state.plan;
  $('st-rows').textContent = fmtInt(table.rows.length);
  $('st-linked').textContent = fmtInt(p.rowsWithImage);
  $('st-images').textContent = fmtInt(p.images.length);
  $('st-orphans').textContent = fmtInt(p.unmatched);

  const warns = [];
  if (p.nonImage) warns.push(`<strong>${fmtInt(p.nonImage)} arquivos ligados às linhas não são imagens</strong> (vídeos, áudios…). O modelo só analisa imagens, e esses arquivos aparecerão como erro no CSV.`);
  const noImg = table.rows.length - p.rowsWithImage;
  if (noImg) warns.push(`${fmtInt(noImg)} linhas não têm imagem correspondente na pasta e serão marcadas como <code>sem_imagem</code>.`);
  showBanner('link-warn', warns.join('<br>'));

  const colName = link.col === MDCore.ROWNUM ? 'número da linha' : `coluna “${table.header[link.col]}”`;
  $('preview-mode').textContent = `${colName} · ${link.mode === 'file' ? 'nome do arquivo' : 'ID → arquivo'}`;
  const first = [];
  for (let i = 0; i < table.rows.length && first.length < 8; i++) if (p.rowFiles[i].length || first.length < 3) first.push(i);
  $('preview-body').innerHTML = first.map(i => {
    const v = link.col === MDCore.ROWNUM ? String(i + 1) : table.rows[i][link.col];
    const files = p.rowFiles[i];
    return `<tr><td>${i + 1}</td><td class="name-cell">${esc(String(v).slice(0, 60))}</td><td>${files.length ? thumbsHTML(files, 4) : '<span style="color:var(--ink-muted)">nenhuma</span>'}</td></tr>`;
  }).join('');

  state.truthCol = parseInt($('truth-col').value, 10);
  $('truth-count').textContent = state.truthCol >= 0 ? `${fmtInt(truthCount(state.truthCol))} linhas com rótulo reconhecido nessa coluna.` : '';

  const hint = !p.images.length ? 'Nenhuma imagem para analisar com essa ligação.' : '';
  $('btn-start').disabled = !!hint;
  $('start-hint').textContent = hint;
  renderCmd();
}

function thumbsHTML(files, max) {
  const shown = files.slice(0, max).map(f => {
    const src = MDCore.IMG_EXT.test(f) ? bridge.thumb(state.folder.path, f) : '';
    return src
      ? `<img class="thumb" loading="lazy" src="${esc(src)}" alt="" title="${esc(f)}" onerror="this.style.visibility='hidden'">`
      : `<span class="thumb" title="${esc(f)}" style="display:flex;align-items:center;justify-content:center;font-size:.9rem">🎞️</span>`;
  }).join('');
  const names = files.length === 1 ? `<span class="name-cell" style="font-size:.72rem;color:var(--ink-muted)">${esc(files[0])}</span>` : '';
  return `<div class="thumbs">${shown}${files.length > max ? `<span class="thumb-more">+${files.length - max}</span>` : ''}${names}</div>`;
}

const clampThr = x => Math.min(0.95, Math.max(0.05, isFinite(x) ? x : 0.5));

/* ── Comando equivalente ───────────────────────────────────────────────── */
function renderCmd(opts = {}) {
  if (!state.table) return;
  const link = state.link;
  const onlyMemes = !!opts.onlyMemes;
  state.cmd = MDCore.cliCommand({
    exe: state.app ? state.app.executable : 'MemeDetection',
    csv: state.csv.path, images: state.folder.path,
    column: link.col === MDCore.ROWNUM ? MDCore.ROWNUM : state.table.header[link.col],
    mode: link.mode, threshold: Math.round(state.threshold * 100) / 100,
    truth: state.truthCol >= 0 ? state.table.header[state.truthCol] : '',
    onlyMemes, includeMetrics: onlyMemes ? $('keep-metrics').checked : true,
    out: joinPath(state.csv.dir, csvStem() + (onlyMemes ? '_memes.csv' : '_memedetection.csv'))
  });
  const text = '# Mesmo resultado pelo Terminal (útil para scripts e bases grandes)\n' + state.cmd;
  document.querySelectorAll('pre[data-cmd="code"]').forEach(p => p.innerHTML = esc(text).replace(/^(#.*)$/m, '<span class="c">$1</span>'));
}

/* ── Passo 3: análise ───────────────────────────────────────────────────── */
async function startRun() {
  showBanner('error-config', ''); showBanner('error-run', ''); showBanner('saved', ''); showBanner('err-hint', '');
  const status = await call('modelStatus');
  if (!status.ready) { showBanner('error-config', 'O modelo não pôde ser carregado: ' + esc(status.error || 'erro desconhecido')); return; }
  const pending = state.plan.images.filter(f => !state.cache.has(f));
  const run = state.run = {
    total: state.plan.images.length, pending, idx: 0, done: state.plan.images.length - pending.length,
    paused: false, cancelled: false, finished: false, pauseGate: null, unpause: null,
    concurrency: Math.min(8, Math.max(1, parseInt($('concurrency').value, 10) || 4)),
    startedAt: Date.now(), cached: state.plan.images.length - pending.length
  };
  $('thr-live').value = String(state.threshold);
  goStep(3);
  $('run-title').textContent = 'Analisando imagens';
  $('run-desc').innerHTML = `${fmtInt(run.total)} imagens de <strong>${esc(state.folder.name)}</strong> ligadas a <strong>${esc(state.csv.name)}</strong>` +
    (run.cached ? ` · ${fmtInt(run.cached)} já analisadas antes` : '');
  $('run-controls').style.display = '';
  $('btn-pause').disabled = false; $('btn-cancel').disabled = false; $('btn-pause').textContent = '⏸ Pausar';
  $('btn-back-2').disabled = true; $('btn-new').disabled = true;
  setSaveEnabled(false);
  renderRun();

  const BATCH = 8;
  const tick = setInterval(renderRun, 400);
  const worker = async () => {
    while (!run.cancelled) {
      if (run.paused) { await run.pauseGate; continue; }
      const start = run.idx;
      if (start >= pending.length) return;
      run.idx += BATCH;
      const part = pending.slice(start, start + BATCH);
      try {
        const res = await call('classify', { root: state.folder.path, files: part, concurrency: 1 });
        for (const f of part) state.cache.set(f, res[f] || { error: 'sem resposta' });
      } catch (e) {
        for (const f of part) state.cache.set(f, { error: String(e.message || e) });
      }
      run.done += part.length;
    }
  };
  await Promise.all(Array.from({ length: run.concurrency }, worker));
  clearInterval(tick);
  run.finished = true;
  renderRun();
}

function computeRowRes() {
  state.rowRes = MDCore.computeRows(state.plan, state.cache, state.threshold);
  return state.rowRes;
}

let resFilter = 'all';
function renderRun() {
  const run = state.run; if (!run) return;
  const pct = run.total ? (run.done / run.total) * 100 : 100;
  $('prog-bar').style.width = pct.toFixed(1) + '%';
  $('prog-text').textContent = `${fmtInt(run.done)} / ${fmtInt(run.total)} (${pct.toFixed(0)}%)`;
  const rr = computeRowRes();
  const s = MDCore.summarize(rr);
  if (!run.finished) {   // linhas ainda em análise não contam como erro
    state.plan.rowFiles.forEach((f, i) => { if (rr[i].label === 'erro' && f.some(x => !state.cache.has(x))) s.erro--; });
  }
  $('rs-meme').textContent = fmtInt(s.meme);
  $('rs-foto').textContent = fmtInt(s.foto);
  $('rs-none').textContent = fmtInt(s.sem_imagem);
  $('rs-err').textContent = fmtInt(s.erro);
  $('rs-low').textContent = fmtInt(s.baixa);
  $('n-memes').textContent = fmtInt(s.meme);
  $('n-meme-imgs').textContent = fmtInt(MDCore.memeImages(state.plan, state.cache, state.threshold).length);
  updateExportCounts();
  $('n-all-imgs').textContent = fmtInt(state.folder.files.filter(f => MDCore.IMG_EXT.test(f.name)).length);
  $('orig-name').textContent = state.csv.name;
  $('thr-val').textContent = fmtDec(state.threshold);

  let status;
  if (run.finished) {
    const secs = Math.round((Date.now() - run.startedAt) / 1000);
    const incomplete = run.cancelled && run.done < run.total;
    status = (run.cancelled ? 'Cancelado' : 'Concluído') + ` em ${secs < 60 ? secs + ' s' : Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s'}`;
    $('run-title').textContent = run.cancelled ? 'Análise cancelada' : 'Análise concluída';
    $('run-controls').style.display = 'none';
    $('btn-back-2').disabled = false; $('btn-new').disabled = false;
    setSaveEnabled(true);
    const errs = {};
    for (const f of state.plan.images) { const r = state.cache.get(f); if (r && r.error) errs[r.error] = (errs[r.error] || 0) + 1; }
    const nErr = Object.values(errs).reduce((a, b) => a + b, 0);
    const lines = Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `• ${fmtInt(n)}× ${esc(e)}`).join('<br>');
    const parts = [];
    if (incomplete) parts.push(`<strong>A análise foi interrompida:</strong> ${fmtInt(run.total - run.done)} imagens não foram analisadas e as linhas correspondentes aparecerão com erro “não analisada”. Clique em <em>Ajustar configuração</em> e depois em <em>Analisar</em> para continuar de onde parou.`);
    if (nErr) parts.push(`<strong>${fmtInt(nErr)} arquivos não puderam ser analisados.</strong><br>${lines}`);
    showBanner('err-hint', parts.join('<br><br>'));
  } else {
    status = run.paused ? 'Pausado' : run.cancelled ? 'Cancelando…' : `Analisando (${run.concurrency} lotes em paralelo)…`;
  }
  $('run-status').textContent = status;
  renderResults();
  renderEval();
}

/* ── Filtro de confiança por exportação ─────────────────────────────────── */
const conf = id => $(id).value;   // 'baixa' (todas), 'media' ou 'alta'
const CONF_LBL = { baixa: '', media: ' de confiança alta ou média', alta: ' de confiança alta' };
function exportCounts() {
  const rr = state.rowRes || [];
  return {
    all: MDCore.countRows(rr, { minConfidence: conf('conf-all') }),
    memes: MDCore.countRows(rr, { onlyMemes: true, minConfidence: conf('conf-memes') }),
    over: MDCore.countRows(rr, { onlyMemes: true, minConfidence: conf('conf-over') }),
    copy: MDCore.memeImages(state.plan, state.cache, state.threshold, conf('conf-copy')).length
  };
}
function updateExportCounts() {
  if (!state.rowRes) return;
  const c = state.exportCounts = exportCounts(), total = state.table.rows.length;
  $('cnt-all').innerHTML = `Serão gravadas <strong>${fmtInt(c.all)}</strong> de ${fmtInt(total)} linhas${CONF_LBL[conf('conf-all')] ? ' (só as' + CONF_LBL[conf('conf-all')] + ')' : ''}.`;
  $('cnt-memes').innerHTML = `Serão gravadas <strong>${fmtInt(c.memes)}</strong> linhas de memes${CONF_LBL[conf('conf-memes')]}.`;
  $('cnt-over').innerHTML = `O original ficará com <strong>${fmtInt(c.over)}</strong> linhas de memes${CONF_LBL[conf('conf-over')]}.`;
  $('cnt-copy').innerHTML = `Serão copiadas <strong>${fmtInt(c.copy)}</strong> imagens de memes${CONF_LBL[conf('conf-copy')]}.`;
}

function setSaveEnabled(on) {
  ['btn-save-all', 'btn-save-memes', 'btn-overwrite', 'btn-copy-memes', 'thr-live', 'btn-eval-save',
   'conf-all', 'conf-memes', 'conf-copy', 'conf-over'].forEach(id => $(id).disabled = !on || state.copying);
  if (on) {
    const c = state.exportCounts || exportCounts();
    $('btn-save-all').disabled = !c.all || state.copying;
    $('btn-save-memes').disabled = !c.memes || state.copying;
    $('btn-overwrite').disabled = !c.over || state.copying;
    $('btn-copy-memes').disabled = !c.copy || state.copying;
  }
}

function renderResults() {
  const rr = state.rowRes, files = state.plan.rowFiles;
  const pass = r => resFilter === 'all' || (resFilter === 'baixa' ? r.level === 'baixa'
    : resFilter === 'erro' ? (r.label === 'erro' || r.label === 'sem_imagem') : r.label === resFilter);
  const idxs = [];
  for (let i = 0; i < rr.length; i++) if (pass(rr[i])) idxs.push(i);
  const LIMIT = 500;
  const pendingLbl = f => !state.run.finished && f.length && f.some(x => !state.cache.has(x));
  $('res-body').innerHTML = idxs.slice(0, LIMIT).map(i => {
    const r = rr[i], f = files[i];
    const label = pendingLbl(f) && r.label !== 'meme' ? 'pendente' : r.label;
    const lblTxt = { meme: 'meme', foto: 'foto', erro: 'erro', sem_imagem: 'sem imagem', pendente: 'analisando' }[label];
    const err = r.errors.length ? `<div class="err-cell">${esc(r.errors.slice(0, 2).join(' · '))}</div>` : '';
    return `<tr><td>${i + 1}</td><td>${f.length ? thumbsHTML(f, 3) : '—'}${err}</td><td><span class="lbl ${label}">${lblTxt}</span>${r.n > 1 ? `<div class="lvl">${r.memes} de ${r.n} memes</div>` : ''}</td>` +
      `<td class="num-cell">${r.p === null ? '—' : formatP(r.p)}</td><td class="num-cell">${r.logit === null ? '—' : fmtDec(r.logit, 2)}</td>` +
      `<td>${r.level ? `<span class="lvl ${r.level === 'baixa' ? 'baixa' : ''}">${r.level}</span>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:var(--ink-muted);padding:1rem">Nenhuma linha neste filtro.</td></tr>';
  $('res-note').textContent = idxs.length > LIMIT ? `Mostrando as primeiras ${fmtInt(LIMIT)} de ${fmtInt(idxs.length)} linhas. O CSV salvo contém todas.` : '';
}
function formatP(p) {
  if (p >= 0.9995 && p < 1) return '>0,999';
  if (p === 1) return '1';
  if (p < 0.0005) return '<0,001';
  return fmtDec(p, 3);
}

function renderEval() {
  const col = state.truthCol;
  $('eval-panel').style.display = col >= 0 ? '' : 'none';
  if (col < 0 || !state.rowRes) return;
  const ev = state.eval = MDCore.evaluate(state.table, state.rowRes, col);
  $('ev-acc').textContent = fmtPct(ev.accuracy);
  $('ev-prec').textContent = fmtPct(ev.precision);
  $('ev-rec').textContent = fmtPct(ev.recall);
  $('ev-f1').textContent = ev.f1 === null ? '—' : fmtDec(ev.f1, 3);
  $('ev-matrix').innerHTML = `<table class="confusion"><tr><th></th><th>previsto meme</th><th>previsto foto</th></tr>` +
    `<tr><th>verdadeiro meme</th><td class="hit">${fmtInt(ev.tp)}</td><td class="miss">${fmtInt(ev.fn)}</td></tr>` +
    `<tr><th>verdadeiro foto</th><td class="miss">${fmtInt(ev.fp)}</td><td class="hit">${fmtInt(ev.tn)}</td></tr></table>`;
  $('ev-note').innerHTML = `${fmtInt(ev.n)} linhas comparadas, usando a coluna <code>${esc(state.table.header[col])}</code> e limiar ${fmtDec(state.threshold)}. ` +
    `${ev.ignored ? fmtInt(ev.ignored) + ' linhas ignoradas (sem rótulo reconhecido, sem imagem ou com erro). ' : ''}Para comparação, o autor do modelo declara 91% de acurácia de validação.`;
}

function togglePause() {
  const run = state.run; if (!run || run.finished) return;
  run.paused = !run.paused;
  $('btn-pause').textContent = run.paused ? '▶ Continuar' : '⏸ Pausar';
  if (run.paused) run.pauseGate = new Promise(r => run.unpause = r);
  else run.unpause();
  renderRun();
}
function cancelRun() {
  const run = state.run; if (!run || run.finished) return;
  run.cancelled = true;
  if (run.paused) { run.paused = false; run.unpause(); }
  renderRun();
}

/* ── Salvar ─────────────────────────────────────────────────────────────── */
function savedBanner(path, what, verb = 'gravado em') {
  const reveal = NATIVE ? ` <button class="btn-small" id="btn-reveal">Mostrar no Finder</button>` : '';
  showBanner('saved', `✓ ${what} ${verb} <code>${esc(path)}</code>${reveal}`);
  if (NATIVE) $('btn-reveal').addEventListener('click', () => call('reveal', { path }));
}
async function doSave(kind) {
  showBanner('error-run', '');
  const rr = computeRowRes();
  try {
    if (kind === 'all') {
      const out = MDCore.outputCSV(state.table, state.plan, rr, { onlyMemes: false, includeMetrics: true, minConfidence: conf('conf-all') });
      const res = await call('saveCSV', { text: out.text, bom: out.bom, name: csvStem() + '_memedetection.csv', dir: state.csv.dir, message: 'Salvar o CSV com rótulos e métricas' });
      if (res) savedBanner(res.path, `CSV com ${fmtInt(out.count)} linhas`);
    } else if (kind === 'memes') {
      const out = MDCore.outputCSV(state.table, state.plan, rr, { onlyMemes: true, includeMetrics: $('keep-metrics').checked, minConfidence: conf('conf-memes') });
      const res = await call('saveCSV', { text: out.text, bom: out.bom, name: csvStem() + '_memes.csv', dir: state.csv.dir, message: 'Salvar só as linhas rotuladas como meme' });
      if (res) savedBanner(res.path, `CSV filtrado com ${fmtInt(out.count)} linhas de memes${CONF_LBL[conf('conf-memes')]}`);
    } else if (kind === 'overwrite') {
      const out = MDCore.outputCSV(state.table, state.plan, rr, { onlyMemes: true, includeMetrics: $('keep-metrics').checked, minConfidence: conf('conf-over') });
      const total = state.table.rows.length;
      const detail = `“${state.csv.name}” será sobrescrito e ficará só com as ${fmtInt(out.count)} linhas rotuladas como meme${CONF_LBL[conf('conf-over')]}, de ${fmtInt(total)}. As outras ${fmtInt(total - out.count)} linhas serão eliminadas` +
        `${$('keep-metrics').checked ? ', e as colunas md_* serão acrescentadas' : ''}. Esta ação não pode ser desfeita.`;
      const res = await call('overwriteCSV', { text: out.text, bom: out.bom, path: state.csv.path, detail });
      if (res) savedBanner(res.path, `CSV original filtrado (${fmtInt(out.count)} linhas)`);
    } else if (kind === 'copy') {
      const files = MDCore.memeImages(state.plan, state.cache, state.threshold, conf('conf-copy'));
      if (!files.length) return;
      state.copying = true; setSaveEnabled(true);
      $('copy-progress').style.display = 'none';
      try {
        const res = await call('copyMemeImages', { root: state.folder.path, files, name: state.folder.name + '_memes' });
        if (res) {
          savedBanner(res.path, `Pasta com ${fmtInt(res.copied)} imagens de memes`, 'criada em');
          $('copy-progress').style.display = '';
          $('copy-progress').textContent = `✓ ${fmtInt(res.copied)} imagens copiadas.`;
          if (res.failed && res.failed.length) {
            showBanner('error-run', `<strong>${fmtInt(res.failed.length)} imagens não puderam ser copiadas:</strong><br>` +
              res.failed.slice(0, 5).map(f => '• ' + esc(f)).join('<br>'));
          }
        }
      } finally { state.copying = false; setSaveEnabled(true); }
    } else if (kind === 'eval') {
      const text = MDCore.evaluationCSV(state.eval, { csv: state.csv.name, truth: state.table.header[state.truthCol], threshold: state.threshold });
      const res = await call('saveCSV', { text, name: csvStem() + '_memedetection_avaliacao.csv', dir: state.csv.dir, message: 'Salvar o relatório de avaliação' });
      if (res) savedBanner(res.path, 'Relatório de avaliação');
    }
  } catch (e) { showBanner('error-run', esc(e.message || e)); }
}

/* ── Tema ──────────────────────────────────────────────────────────────── */
function initTheme() {
  const btn = $('theme-btn');
  const apply = theme => { document.documentElement.dataset.theme = theme; btn.textContent = theme === 'dark' ? '☀️' : '🌙'; };
  let stored = null;
  try { stored = localStorage.getItem('md-theme'); } catch {}
  apply(stored || (window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'));
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('md-theme', next); } catch {}
    apply(next);
  });
}

/* ── Inicialização ─────────────────────────────────────────────────────── */
async function init() {
  initTheme();
  if (!NATIVE && !MOCK) {
    showBanner('env-warn', 'Esta é a interface do <strong>app MemeDetection para macOS</strong>: a classificação usa o Core ML do Mac e não funciona no navegador. Baixe o app em <a href="https://memedetection.colab.meme/">memedetection.colab.meme</a>. Para só testar a interface, adicione <code>?mock=1</code> ao endereço.');
    ['dz-csv', 'dz-folder'].forEach(id => $(id).style.pointerEvents = 'none');
    $('model-line').style.display = 'none';
    return;
  }
  if (MOCK) showBanner('env-warn', '<strong>Modo simulado</strong> para testar a interface no navegador: os rótulos são fictícios. Imagens com “meme” no nome saem como memes.');

  try { state.app = await call('appInfo'); } catch {}
  call('modelStatus').then(s => {
    const dot = s.ready ? 'ok' : 'err';
    $('model-line').innerHTML = `<span class="dot ${dot}"></span>` + (s.ready
      ? `Modelo carregado: meme-detection 1.0 (Boháček), Core ML local${s.exactLogit ? ', com log-odds calculado a partir das features' : ''}${s.simulated ? ' <em>(simulado)</em>' : ''} · v${esc(state.app ? state.app.version : '')}`
      : 'Não foi possível carregar o modelo: ' + esc(s.error || ''));
  }).catch(e => { $('model-line').innerHTML = '<span class="dot err"></span>Erro ao carregar o modelo: ' + esc(e.message || e); });

  const dzc = $('dz-csv'), dzf = $('dz-folder');
  dzc.addEventListener('click', pickCSV);
  dzf.addEventListener('click', pickFolder);
  [dzc, dzf].forEach(dz => dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dz.click(); } }));
  if (MOCK) {   // no navegador, arrastar o CSV funciona pela própria página
    dzc.addEventListener('dragover', e => { e.preventDefault(); dzc.classList.add('drag-over'); });
    dzc.addEventListener('dragleave', () => dzc.classList.remove('drag-over'));
    dzc.addEventListener('drop', async e => { e.preventDefault(); dzc.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) setCSV(await mockBridge.fromCSV(f)); });
  }
  $('csv-remove').addEventListener('click', () => { state.csv = state.table = null; state.link = null; $('card-csv').classList.remove('visible'); dzc.classList.remove('loaded'); showBanner('error-files', ''); refreshStep1(); });
  $('folder-remove').addEventListener('click', () => { state.folder = state.idx = null; $('card-folder').classList.remove('visible'); dzf.classList.remove('loaded'); showBanner('error-files', ''); refreshStep1(); });
  $('btn-continue-1').addEventListener('click', () => { setupConfig(); goStep(2); });

  $('link-list').addEventListener('change', e => {
    if (e.target.name !== 'link') return;
    const c = e.target.dataset.col;
    state.link = { col: c === MDCore.ROWNUM ? c : parseInt(c, 10), mode: e.target.dataset.mode };
    recompute();
  });
  $('threshold').addEventListener('input', recompute);
  $('truth-col').addEventListener('change', recompute);
  $('btn-back-1').addEventListener('click', () => goStep(1));
  $('btn-start').addEventListener('click', startRun);

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-cancel').addEventListener('click', cancelRun);
  $('thr-live').addEventListener('input', e => {
    state.threshold = clampThr(parseFloat(e.target.value));
    $('threshold').value = String(state.threshold);
    $('copy-progress').style.display = 'none';
    renderRun(); setSaveEnabled(state.run.finished); renderCmd();
  });
  $('keep-metrics').addEventListener('change', () => renderCmd());
  document.querySelectorAll('.conf-sel').forEach(sel => sel.addEventListener('change', () => {
    if (sel.id === 'conf-copy') $('copy-progress').style.display = 'none';
    updateExportCounts();
    if (state.run && state.run.finished) setSaveEnabled(true);
  }));
  $('btn-save-all').addEventListener('click', () => doSave('all'));
  $('btn-save-memes').addEventListener('click', () => doSave('memes'));
  $('btn-overwrite').addEventListener('click', () => doSave('overwrite'));
  $('btn-eval-save').addEventListener('click', () => doSave('eval'));
  $('btn-copy-memes').addEventListener('click', () => doSave('copy'));
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    resFilter = b.dataset.filter; renderResults();
  }));
  $('btn-back-2').addEventListener('click', () => { recompute(); goStep(2); });
  $('btn-new').addEventListener('click', () => { state.run = null; goStep(1); });

  document.querySelectorAll('.rbox button[data-cmd]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    await call('copy', { text: state.cmd });
    const t = b.textContent; b.textContent = '✓ Copiado'; setTimeout(() => b.textContent = t, 1400);
  }));
  $('logo').addEventListener('click', e => { e.preventDefault(); if (!state.run || state.run.finished) goStep(1); });
}

init();
