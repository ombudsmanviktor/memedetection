/* ═══════════════════════════════════════════════════════════════════════════
   MemeDetection — lógica compartilhada (interface e modo CLI)
   Sem DOM: roda no WKWebView e também no JavaScriptCore do modo CLI, para que
   os dois produzam exatamente o mesmo CSV. Depende de PapaParse (global Papa).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const VERSION = '1.2.0';
  const MODEL_VAL_ACCURACY = 0.91;      // declarada no README do modelo (Bohacek, 2020)
  const ROWNUM = '#linha';              // pseudo-coluna: número da linha (1 = primeira linha de dados)
  const MD_FIELDS = ['md_rotulo', 'md_prob_meme', 'md_confianca', 'md_logit', 'md_nivel_confianca',
    'md_n_imagens', 'md_n_memes', 'md_arquivos', 'md_erro', 'md_acuracia_validacao_modelo'];
  const IMG_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i;
  const MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif|mp4|m4v|mov|webm|mkv|avi|3gp|mp3|m4a|aac|wav|ogg|opus|flac|pdf|svg)$/i;

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function isEmptyCell(v) {
    if (v === null || v === undefined) return true;
    const s = String(v).trim();
    return s === '' || s === 'NA' || s === 'N/A' || s === 'NULL' || s === 'null' || s === 'NaN';
  }
  // Mesmo cleanName do WgetLAB: nomes de arquivo gerados a partir de IDs
  function cleanName(s) {
    return String(s).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  }
  const baseName = p => String(p).split(/[\\/]/).pop();
  const stemOf = n => n.replace(/\.[^.]+$/, '');
  const logitOf = p => Math.log(p / (1 - p));

  /* ── CSV ──────────────────────────────────────────────────────────────── */
  // Lê sem modo cabeçalho do PapaParse para preservar colunas duplicadas,
  // a ordem original e o texto exato de cada célula.
  // bom: o app nativo informa se o arquivo tinha BOM UTF-8 (as pontes de texto
  // do Swift o descartam); a saída é gravada com o mesmo BOM pelo lado nativo.
  function parseCSV(text, bom) {
    bom = !!bom;
    if (text.charCodeAt(0) === 0xFEFF) { bom = true; text = text.slice(1); }
    const res = Papa.parse(text, { header: false, skipEmptyLines: 'greedy' });
    const data = res.data || [];
    if (data.length < 2) return { error: 'Não foi possível ler linhas nesse arquivo. Verifique se é um CSV com cabeçalho e ao menos uma linha de dados.' };
    const header = data[0].map(String);
    const rows = data.slice(1);
    const width = header.length;
    for (const r of rows) while (r.length < width) r.push('');
    return { header, rows, bom, delimiter: res.meta.delimiter || ',', linebreak: res.meta.linebreak || '\n' };
  }

  function toCSV(table, header, rows) {
    const text = Papa.unparse({ fields: header, data: rows }, {
      delimiter: table.delimiter, newline: table.linebreak, quotes: false
    });
    return text + table.linebreak;
  }

  /* ── Índice da pasta de imagens ───────────────────────────────────────── */
  // files: [{name: 'sub/arquivo.jpg', size}] — caminhos relativos à pasta escolhida
  function indexFiles(files) {
    const byName = new Map(), byStem = new Map();
    for (const f of files) {
      const b = baseName(f.name).toLowerCase(), st = stemOf(b);
      if (!byName.has(b)) byName.set(b, f.name);
      if (!byStem.has(st)) byStem.set(st, []);
      byStem.get(st).push(f.name);
    }
    for (const list of byStem.values()) list.sort(natCmp);
    return { files, byName, byStem };
  }
  function natCmp(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

  // Mapa de prefixos: "123_2" e "123_capa_1" → "123". Construído só com os
  // arquivos que não casam exatamente com nenhum ID, para evitar ambiguidade.
  function prefixIndex(idx, exactKeys) {
    const map = new Map();
    for (const [st, list] of idx.byStem) {
      if (exactKeys.has(st)) continue;
      for (let i = st.indexOf('_'); i > 0; i = st.indexOf('_', i + 1)) {
        const p = st.slice(0, i);
        if (!map.has(p)) map.set(p, []);
        map.get(p).push(...list);
      }
    }
    return map;
  }

  /* ── Ligação linha ↔ imagem ───────────────────────────────────────────── */
  function cellKey(table, rowIdx, col) {
    if (col === ROWNUM) return String(rowIdx + 1);
    return table.rows[rowIdx][col];
  }

  // Modo "arquivo": a célula tem o nome (ou caminho/URL) de um ou mais arquivos
  function filesFromCell(idx, v) {
    if (isEmptyCell(v)) return [];
    const parts = String(v).split(/\s*[|;\n]\s*|\s*,\s*(?=[^,]*\.[A-Za-z0-9]{2,5}\b)/);
    const out = [];
    for (let p of parts) {
      p = p.trim().replace(/[?#].*$/, '');
      if (!p) continue;
      const b = baseName(p).toLowerCase();
      let hit = idx.byName.get(b);
      if (!hit && !MEDIA_EXT.test(b)) { const l = idx.byStem.get(b); hit = l && l[0]; }
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  }

  // Modo "ID": arquivos <id>.<ext>, <id>_<n>.<ext>, <id>_<coluna>_<n>.<ext> (padrão WgetLAB)
  function makeIdMatcher(table, idx, col) {
    const keys = table.rows.map((_, i) => {
      const v = cellKey(table, i, col);
      return isEmptyCell(v) ? '' : cleanName(String(v).trim()).toLowerCase();
    });
    const exact = new Set(keys.filter(k => k && idx.byStem.has(k)));
    const pre = prefixIndex(idx, exact);
    return i => {
      const k = keys[i];
      if (!k) return [];
      const out = (idx.byStem.get(k) || []).slice();
      for (const f of pre.get(k) || []) if (!out.includes(f)) out.push(f);
      return out.sort(natCmp);
    };
  }

  function linkRows(table, idx, col, mode) {
    if (mode === 'file') return table.rows.map((r, i) => filesFromCell(idx, cellKey(table, i, col)));
    const m = makeIdMatcher(table, idx, col);
    return table.rows.map((_, i) => m(i));
  }

  // Avalia cada coluna nos dois modos e sugere a melhor ligação
  function analyzeLinks(table, idx) {
    const cols = [{ col: ROWNUM, label: 'Número da linha' }]
      .concat(table.header.map((h, i) => ({ col: i, label: h })));
    const sample = table.rows.length > 5000 ? 5000 : table.rows.length;   // estimativa rápida em CSVs grandes
    const sub = { ...table, rows: table.rows.slice(0, sample) };
    const stats = cols.map(c => {
      let fileHits = 0, idHits = 0;
      if (c.col !== ROWNUM) for (let i = 0; i < sample; i++) if (filesFromCell(idx, sub.rows[i][c.col]).length) fileHits++;
      const m = makeIdMatcher(sub, idx, c.col);
      for (let i = 0; i < sample; i++) if (m(i).length) idHits++;
      const scale = table.rows.length / (sample || 1);
      const mode = fileHits >= idHits && fileHits > 0 ? 'file' : 'id';
      return { ...c, mode, hits: Math.round((mode === 'file' ? fileHits : idHits) * scale), estimated: sample < table.rows.length };
    });
    const best = stats.slice().sort((a, b) => b.hits - a.hits || (a.col === ROWNUM) - (b.col === ROWNUM))[0];
    return { stats, best: best && best.hits ? best : null };
  }

  function planRun(table, idx, col, mode) {
    const rowFiles = linkRows(table, idx, col, mode);
    const used = new Set(), images = [];
    rowFiles.forEach(list => list.forEach(f => { if (!used.has(f)) { used.add(f); images.push(f); } }));
    const unmatched = idx.files.filter(f => !used.has(f.name)).length;
    const nonImage = images.filter(f => !IMG_EXT.test(f)).length;
    return {
      rowFiles, images, unmatched, nonImage,
      rowsWithImage: rowFiles.filter(l => l.length).length
    };
  }

  /* ── Resultados por linha ─────────────────────────────────────────────── */
  // results: Map/obj arquivo → {p, logit, error}
  function confidenceLevel(logit, threshold) {
    const d = Math.abs(logit - logitOf(threshold));
    return d >= 8 ? 'alta' : d >= 3 ? 'média' : 'baixa';
  }
  const fmtP = p => String(Number(p.toPrecision(4)));
  const fmtL = l => l.toFixed(3);

  function rowResult(files, results, threshold) {
    const out = { label: 'sem_imagem', p: null, logit: null, conf: null, level: '', n: files.length, memes: 0, errors: [] };
    if (!files.length) return out;
    let best = null;
    for (const f of files) {
      const r = results.get(f);
      if (!r) { out.errors.push(baseName(f) + ': não analisada'); continue; }
      if (r.error) { out.errors.push(baseName(f) + ': ' + r.error); continue; }
      if (r.p >= threshold) out.memes++;
      if (!best || r.logit > best.logit) best = r;
    }
    if (!best) { out.label = 'erro'; return out; }
    out.label = out.memes > 0 ? 'meme' : 'foto';          // meme se alguma imagem for meme
    out.p = best.p; out.logit = best.logit;
    out.conf = out.label === 'meme' ? best.p : 1 - best.p;
    out.level = confidenceLevel(best.logit, threshold);
    return out;
  }

  function computeRows(plan, results, threshold) {
    return plan.rowFiles.map(files => rowResult(files, results, threshold));
  }

  function mdValues(r, files) {
    return [
      r.label,
      r.p === null ? '' : fmtP(r.p),
      r.conf === null ? '' : fmtP(r.conf),
      r.logit === null ? '' : fmtL(r.logit),
      r.level,
      String(r.n),
      String(r.memes),
      files.join(' | '),
      r.errors.join(' | '),
      String(MODEL_VAL_ACCURACY)
    ];
  }

  // opts: {onlyMemes, includeMetrics}
  /* Filtro de confiança das exportações. minConfidence: 'baixa' (todas as
     linhas, padrão), 'media' (alta e média) ou 'alta' (só alta). Com filtro,
     linhas sem imagem ou com erro ficam de fora: elas não têm classificação. */
  const CONF_RANK = { 'baixa': 0, 'média': 1, 'alta': 2 };
  function normMinConf(m) {
    const s = String(m || 'baixa').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s === 'alta' ? 'alta' : s === 'media' ? 'média' : 'baixa';
  }
  function passesConf(level, minConfidence) {
    const min = normMinConf(minConfidence);
    if (min === 'baixa') return true;
    return !!level && CONF_RANK[level] >= CONF_RANK[min];
  }
  function keepRow(r, opts) {
    if (opts.onlyMemes && r.label !== 'meme') return false;
    return passesConf(r.level, opts.minConfidence);
  }
  function countRows(rowRes, opts) { return rowRes.reduce((n, r) => n + (keepRow(r, opts) ? 1 : 0), 0); }

  // opts: {onlyMemes, includeMetrics, minConfidence}
  function outputCSV(table, plan, rowRes, opts) {
    const include = opts.includeMetrics !== false;
    const header = include ? table.header.concat(MD_FIELDS) : table.header.slice();
    const rows = [];
    table.rows.forEach((r, i) => {
      if (!keepRow(rowRes[i], opts)) return;
      rows.push(include ? r.concat(mdValues(rowRes[i], plan.rowFiles[i])) : r);
    });
    return { text: toCSV(table, header, rows), count: rows.length, bom: table.bom };
  }

  // Imagens classificadas como meme (nível da imagem, não da linha), sem
  // repetição, na ordem em que aparecem no CSV. Usado para copiar só os memes.
  // minConfidence usa o nível de confiança de cada imagem (não o da linha).
  function memeImages(plan, results, threshold, minConfidence) {
    const out = [];
    for (const f of plan.images) {
      const r = results.get(f);
      if (r && !r.error && r.p >= threshold && passesConf(confidenceLevel(r.logit, threshold), minConfidence)) out.push(f);
    }
    return out;
  }

  function summarize(rowRes) {
    const s = { meme: 0, foto: 0, sem_imagem: 0, erro: 0, baixa: 0 };
    for (const r of rowRes) { s[r.label]++; if (r.level === 'baixa') s.baixa++; }
    return s;
  }

  /* ── Avaliação com rótulo verdadeiro (opcional) ───────────────────────── */
  const TRUE_MEME = /^(meme|memes|1|true|verdadeiro|sim|yes|y|s|m)$/i;
  const TRUE_PHOTO = /^(foto|fotos|photo|photos|fotografia|imagem|0|false|falso|n[aã]o|no|n|f|p)$/i;
  function truthOf(v) {
    if (isEmptyCell(v)) return null;
    const s = String(v).trim();
    return TRUE_MEME.test(s) ? 'meme' : TRUE_PHOTO.test(s) ? 'foto' : null;
  }
  function evaluate(table, rowRes, truthCol) {
    let tp = 0, fp = 0, tn = 0, fn = 0, ignored = 0;
    table.rows.forEach((r, i) => {
      const t = truthOf(r[truthCol]), pr = rowRes[i].label;
      if (!t || (pr !== 'meme' && pr !== 'foto')) { ignored++; return; }
      if (t === 'meme') pr === 'meme' ? tp++ : fn++;
      else pr === 'meme' ? fp++ : tn++;
    });
    const n = tp + fp + tn + fn;
    const div = (a, b) => b ? a / b : null;
    const precision = div(tp, tp + fp), recall = div(tp, tp + fn);
    const f1 = precision !== null && recall !== null && precision + recall ? 2 * precision * recall / (precision + recall) : null;
    return { n, ignored, tp, fp, tn, fn, accuracy: div(tp + tn, n), precision, recall, f1, specificity: div(tn, tn + fp) };
  }
  function evaluationCSV(ev, meta) {
    const f = v => v === null ? '' : v.toFixed(4);
    const rows = [
      ['arquivo_csv', meta.csv], ['coluna_rotulo_verdadeiro', meta.truth], ['limiar', String(meta.threshold)],
      ['linhas_avaliadas', String(ev.n)], ['linhas_ignoradas', String(ev.ignored)],
      ['acuracia', f(ev.accuracy)], ['precisao_meme', f(ev.precision)], ['recall_meme', f(ev.recall)],
      ['f1_meme', f(ev.f1)], ['especificidade', f(ev.specificity)],
      ['verdadeiro_meme_previsto_meme', String(ev.tp)], ['verdadeiro_meme_previsto_foto', String(ev.fn)],
      ['verdadeiro_foto_previsto_meme', String(ev.fp)], ['verdadeiro_foto_previsto_foto', String(ev.tn)]
    ];
    return Papa.unparse({ fields: ['metrica', 'valor'], data: rows }) + '\n';
  }

  /* ── Comando CLI equivalente ──────────────────────────────────────────── */
  const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  function cliCommand(o) {
    const parts = [shq(o.exe), '--csv', shq(o.csv), '--images', shq(o.images),
      '--column', shq(o.column), '--mode', o.mode];
    if (o.threshold !== 0.5) parts.push('--threshold', String(o.threshold));
    if (o.truth) parts.push('--truth', shq(o.truth));
    if (o.onlyMemes) parts.push('--only-memes');
    if (o.includeMetrics === false) parts.push('--no-metrics');
    if (o.minConfidence && normMinConf(o.minConfidence) !== 'baixa') parts.push('--min-confidence', normMinConf(o.minConfidence) === 'alta' ? 'alta' : 'media');
    if (o.copyMemes) parts.push('--copy-memes', shq(o.copyMemes));
    parts.push('--out', shq(o.out));
    return parts.join(' \\\n  ');
  }

  /* ── Ponte para o modo CLI (JavaScriptCore) ───────────────────────────── */
  const cli = {
    _s: null,
    plan(csvText, filesJSON, optsJSON) {
      const opts = JSON.parse(optsJSON), files = JSON.parse(filesJSON);
      const table = parseCSV(csvText, opts.bom);
      if (table.error) return JSON.stringify({ error: table.error });
      const idx = indexFiles(files);
      let col, mode = opts.mode;
      if (opts.column) {
        if (opts.column === ROWNUM) col = ROWNUM;
        else { col = table.header.indexOf(opts.column); if (col < 0) return JSON.stringify({ error: `Coluna "${opts.column}" não existe no CSV. Colunas: ${table.header.join(', ')}` }); }
        if (!mode || mode === 'auto') {
          const st = analyzeLinks(table, idx).stats.find(s => s.col === col);
          mode = st.mode;
        }
      } else {
        const a = analyzeLinks(table, idx);
        if (!a.best) return JSON.stringify({ error: 'Nenhuma coluna do CSV corresponde aos arquivos da pasta. Use --column para indicar a coluna com o nome do arquivo ou o ID.' });
        col = a.best.col; if (!mode || mode === 'auto') mode = a.best.mode;
      }
      const plan = planRun(table, idx, col, mode);
      let truth = null;
      if (opts.truth) { truth = table.header.indexOf(opts.truth); if (truth < 0) return JSON.stringify({ error: `Coluna de rótulo verdadeiro "${opts.truth}" não existe.` }); }
      this._s = { table, plan, truth, opts };
      return JSON.stringify({
        column: col === ROWNUM ? ROWNUM : table.header[col], mode, rows: table.rows.length,
        rowsWithImage: plan.rowsWithImage, images: plan.images, unmatched: plan.unmatched
      });
    },
    finish(resultsJSON) {
      const { table, plan, truth, opts } = this._s;
      const results = new Map(Object.entries(JSON.parse(resultsJSON)));
      const threshold = opts.threshold ?? 0.5;
      const rowRes = computeRows(plan, results, threshold);
      const out = outputCSV(table, plan, rowRes, { onlyMemes: !!opts.onlyMemes, includeMetrics: opts.includeMetrics !== false, minConfidence: opts.minConfidence });
      const res = { csv: out.text, bom: out.bom, written: out.count, summary: summarize(rowRes),
                    memeImages: memeImages(plan, results, threshold, opts.minConfidence) };
      if (truth !== null) {
        const ev = evaluate(table, rowRes, truth);
        res.evaluation = ev;
        res.evaluationCSV = evaluationCSV(ev, { csv: opts.csvName, truth: opts.truth, threshold });
      }
      return JSON.stringify(res);
    }
  };

  root.MDCore = {
    VERSION, MODEL_VAL_ACCURACY, ROWNUM, MD_FIELDS, IMG_EXT,
    isEmptyCell, cleanName, baseName, logitOf,
    parseCSV, toCSV, indexFiles, analyzeLinks, planRun, linkRows,
    computeRows, outputCSV, summarize, memeImages, passesConf, countRows, normMinConf, confidenceLevel, truthOf, evaluate, evaluationCSV, cliCommand, cli
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
