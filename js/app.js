import { parseLines, looksLikeHtml, extractFromHtml, extractGenericImages, parseCaveduckUrl } from './url.js';
import { parseImage, decodeStealth, mergeStealth } from './parser.js';
import { makeZip } from './zip.js';

const $ = (s) => document.querySelector(s);

// ───────────── 작은 DOM 헬퍼 (외부 데이터는 항상 textContent 로만 넣는다) ─────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

// ───────────── 저장소 (실패해도 동작) ─────────────
const store = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast('복사했습니다');
}
const copyBtn = (getText, label = '복사') => h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(typeof getText === 'function' ? getText() : getText) }, label);

function download(name, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const slug = (t) => String(t || 'image').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image';
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

// 갤러리 화면의 개발자 도구 콘솔에서 실행하면, 갤러리 이미지 원본 주소를 모두 모아 클립보드에 복사하는 코드
const GALLERY_SNIPPET = String.raw`(async()=>{
  const box=document.querySelector('div[class*="min-h-[40dvh]"][class*="overflow-y-auto"]');
  if(!box){console.log('영역을 못 찾았어요. 갤러리를 연 상태에서 실행하세요');return;}
  box.style.outline='3px solid lime';
  const s=new Set();
  const grab=()=>box.querySelectorAll('img').forEach(i=>{
    let u=/^https?:/.test(i.alt||'')?i.alt:(i.currentSrc||i.src);
    if(!u||/charim-blur/.test(u))return;
    s.add(u.replace(/\/cdn-cgi\/image\/[^/]+\//,'/'));
  });
  for(let y=0;y<=box.scrollHeight;y+=box.clientHeight*0.9){box.scrollTop=y;await new Promise(r=>setTimeout(r,100));grab();}
  grab();box.style.outline='';
  const t=[...s].join('\n');
  const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();
  const ok=document.execCommand('copy');ta.remove();
  console.log((ok?'클립보드에 복사됨 - ':'복사 실패, 아래를 직접 복사 - ')+s.size+'개\n'+t);
})();`;

// ───────────── 설정 ─────────────
const settings = {
  get proxy() { return $('#proxy').value.trim(); },
  get proxyOnly() { return $('#proxyOnly').checked; },
  get tryAll() { return $('#tryAll').checked; },
  get stealth() { return $('#stealth').checked; },
  get zipAll() { return $('#zipAll').checked; },
};
function initSettings() {
  $('#proxy').value = store.get('cdm.proxy');
  $('#proxyOnly').checked = store.get('cdm.proxyOnly') === '1';
  $('#tryAll').checked = store.get('cdm.tryAll') === '1';
  $('#stealth').checked = store.get('cdm.stealth', '1') === '1';
  $('#proxy').addEventListener('change', () => store.set('cdm.proxy', settings.proxy));
  $('#zipAll').checked = store.get('cdm.zipAll') === '1';
  $('#zipAll').addEventListener('change', syncEmpty);
  for (const id of ['proxyOnly', 'tryAll', 'stealth', 'zipAll']) {
    $(`#${id}`).addEventListener('change', (e) => store.set(`cdm.${id}`, e.target.checked ? '1' : '0'));
  }
}

function proxied(url) {
  const p = settings.proxy;
  if (!p) return null;
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
  return p + (p.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
}

// ───────────── 가져오기 ─────────────

/** <img> 로 로드 가능한지 확인 (CORS 와 무관하게 존재 여부만 알 수 있음) */
function probeImg(url, timeout = 15000) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; resolve({ ok: false, timeout: true }); }, timeout);
    img.onload = () => { clearTimeout(t); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); resolve({ ok: false }); };
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

const HDRS = ['content-type', 'content-length', 'cf-polished', 'cf-cache-status', 'cf-resized', 'last-modified', 'x-upstream-status'];
function pickHeaders(res) {
  const o = {};
  for (const k of HDRS) { const v = res.headers.get(k); if (v) o[k] = v; }
  return o;
}

/** 후보 하나를 직접 → 프록시 순으로 가져온다 */
async function fetchCandidate(url) {
  const log = [];
  const tryOne = async (via, u) => {
    try {
      const res = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      const headers = pickHeaders(res);
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.text()).slice(0, 200); } catch { /* 무시 */ }
        log.push({ via, ok: false, status: res.status, headers, msg });
        return null;
      }
      const buf = await res.arrayBuffer();
      log.push({ via, ok: true, status: res.status, headers });
      return { buf, via, status: res.status, headers };
    } catch (err) {
      log.push({ via, ok: false, cors: true, msg: String(err?.message || err) });
      return null;
    }
  };
  let got = null;
  if (!settings.proxyOnly || !settings.proxy) got = await tryOne('직접', url);
  const p = proxied(url);
  // 직접 요청이 404 등 HTTP 오류였다면 프록시로 다시 해도 같으므로 CORS/네트워크 실패일 때만 프록시 사용
  if (!got && p && (settings.proxyOnly || log.at(-1)?.cors)) got = await tryOne('프록시', p);
  return { got, log };
}

// ───────────── 렌더링: 메타데이터 ─────────────

function field(label, text) {
  if (!text) return null;
  return h('div', { class: 'field' },
    h('div', { class: 'field-head' }, h('span', {}, label), copyBtn(text)),
    h('pre', { class: 'txt' }, text));
}

function renderSummary(s) {
  const box = h('div', { class: 'sum' }, h('h4', {}, s.title));
  box.append(field('프롬프트', s.prompt) || '', field('네거티브 프롬프트', s.negative) || '');
  s.characters?.forEach((c, i) => {
    box.append(field(`캐릭터 ${i + 1} 프롬프트${c.centers ? ` · 위치 ${c.centers}` : ''}`, c.prompt) || '');
    box.append(field(`캐릭터 ${i + 1} 네거티브`, c.negative) || '');
  });
  const keys = Object.keys(s.params || {});
  if (keys.length) {
    const tbl = h('table', { class: 'params' });
    for (const k of keys) tbl.append(h('tr', {}, h('td', {}, k), h('td', {}, String(s.params[k]))));
    box.append(h('div', { class: 'field' },
      h('div', { class: 'field-head' }, h('span', {}, '설정'), copyBtn(() => keys.map((k) => `${k}: ${s.params[k]}`).join('\n'))),
      tbl));
  }
  return box;
}

function renderEntry(e) {
  const isJson = e.json !== undefined;
  const text = isJson ? JSON.stringify(e.json, null, 2) : e.value;
  const big = text.length > 1500 || e.key === 'workflow' || e.key === 'XMP';
  const d = h('details', { class: 'raw', open: !big || null },
    h('summary', {},
      h('span', { class: 'tag' }, e.source),
      h('b', {}, e.key),
      e.translatedKey ? h('span', { class: 'tag' }, `(${e.translatedKey}${e.lang ? `, ${e.lang}` : ''})`) : null,
      h('span', { class: 'grow' }, `${isJson ? 'JSON · ' : ''}${text.length.toLocaleString()}자`),
      h('button', { class: 'btn sm', type: 'button', onclick: (ev) => { ev.preventDefault(); copyText(e.value); } }, '복사')),
    h('div', { class: 'body' }, h('pre', { class: 'txt' }, text)));
  return d;
}

function renderMeta(container, meta, { bytes, sourceLabel, derived, exportBase, saveStem }) {
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: meta.mime }));
  const facts = h('dl', { class: 'facts' });
  const fact = (k, v) => { if (v != null && v !== '') facts.append(h('dt', {}, k), h('dd', {}, String(v))); };
  fact('출처', sourceLabel);
  fact('형식', meta.format + (meta.webpCodec ? ` · ${meta.webpCodec}` : '') + (meta.progressive ? ' · progressive' : ''));
  fact('해상도', meta.width ? `${meta.width} × ${meta.height}` : '알 수 없음');
  fact('파일 크기', `${fmtSize(meta.size)} (${meta.size.toLocaleString()} B)`);
  if (meta.animated) fact('애니메이션', meta.frames ? `${meta.frames} 프레임` : '예');
  if (meta.hasAlpha) fact('알파 채널', '있음');
  fact('메타 항목 수', meta.entries.length);

  const ext = { PNG: 'png', JPEG: 'jpg', WebP: 'webp', GIF: 'gif', AVIF: 'avif' }[meta.format] || 'bin';
  const fileName = `${saveStem || exportBase}.${ext}`;
  const saveFile = () => download(fileName, new Blob([bytes], { type: meta.mime }));
  const side = h('div', { class: 'side' },
    h('div', { class: 'preview' }, h('img', { src: blobUrl, alt: '미리보기', loading: 'lazy' })),
    h('button', { class: 'primary save-btn', type: 'button', onclick: saveFile }, '원본 이미지 저장'),
    h('p', { class: 'muted' }, meta.hasGenerationInfo
      ? '받은 파일을 그대로 저장해서 생성 정보가 함께 들어 있어요.'
      : '받은 파일을 손대지 않고 그대로 저장해요.'));
  if (meta.format !== 'HTML') {
    const card = container.closest('.card') || container;
    savedFiles.push({
      card, target: container, name: fileName, bytes, hasGen: meta.hasGenerationInfo, blobUrl,
      title: card.querySelector('h2')?.textContent || fileName,
      prompt: meta.summaries[0]?.prompt || '',
      source: meta.summaries[0]?.type || '',
      size: meta.width ? `${meta.width}×${meta.height}` : '',
    });
  }
  const main = h('div', {}, facts);

  if (!meta.hasGenerationInfo) {
    main.append(h('div', { class: 'note warn' },
      h('b', {}, '이 파일에는 생성 정보가 없음'),
      h('p', {}, '업로드·변환 과정에서 제거됐을 가능성이 큽니다.' +
        (derived ? ' (사이트가 줄이거나 다시 인코딩한 파일이라 메타데이터가 거의 남지 않아요.)' : '') +
        (meta.entries.length ? ' 아래는 남아 있는 일반 메타데이터입니다.' : ''))));
  } else {
    main.append(h('div', { class: 'note ok' }, h('b', {}, '생성 정보를 찾았습니다')));
  }
  for (const n of meta.notes) main.append(h('div', { class: 'note err' }, n));

  const out = h('div', {}, h('div', { class: 'result' }, side, main));
  for (const s of meta.summaries) out.append(renderSummary(s));
  if (meta.entries.length) {
    out.append(h('h3', {}, '원본 메타데이터 항목'));
    for (const e of meta.entries) out.append(renderEntry(e));
  }
  out.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn', type: 'button', onclick: () => download(`${exportBase}.json`, JSON.stringify(exportJson(meta, sourceLabel), null, 2)) }, '결과 JSON 다운로드'),
    h('button', { class: 'btn', type: 'button', onclick: saveFile }, '원본 이미지 저장'),
    meta.summaries.length ? copyBtn(() => meta.summaries.map(summaryText).join('\n\n'), '요약 전체 복사') : null));
  container.append(out);
  syncEmpty();
  return out;
}

/** 저장 파일 이름: caveduck 은 uuid, 그 밖은 원래 파일 이름(너무 흔한 이름이면 사이트 이름을 붙임) */
function saveStemFor(parsed, cand) {
  if (parsed.uuid) return parsed.uuid;
  let stem = 'image';
  try { stem = decodeURIComponent(new URL(cand.url).pathname).split('/').filter(Boolean).pop() || 'image'; } catch { /* 기본값 */ }
  stem = stem.replace(/\.[a-z0-9]{2,5}$/i, '');
  if (/^(img|image|images?|file|download|original|\d{1,3})$/i.test(stem)) stem = `${parsed.site || 'image'}_${stem}`;
  return slug(stem);
}

function summaryText(s) {
  const lines = [`[${s.title}]`];
  if (s.prompt) lines.push(`Prompt: ${s.prompt}`);
  if (s.negative) lines.push(`Negative: ${s.negative}`);
  s.characters?.forEach((c, i) => { lines.push(`Character ${i + 1}: ${c.prompt}`); if (c.negative) lines.push(`Character ${i + 1} negative: ${c.negative}`); });
  for (const [k, v] of Object.entries(s.params || {})) lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

function exportJson(meta, source, extra = {}) {
  return {
    tool: 'zzun-meta-thief',
    exportedAt: new Date().toISOString(),
    source,
    ...extra,
    file: { format: meta.format, mime: meta.mime, width: meta.width, height: meta.height, size: meta.size, animated: !!meta.animated, hasAlpha: !!meta.hasAlpha },
    hasGenerationInfo: meta.hasGenerationInfo,
    summaries: meta.summaries,
    entries: meta.entries.map(({ json, ...rest }) => rest),
    notes: meta.notes,
  };
}

async function analyzeBytes(buf) {
  let meta = await parseImage(buf);
  if (settings.stealth && !meta.hasGenerationInfo && (meta.format === 'PNG' || meta.format === 'WebP') && meta.width * meta.height <= 40e6) {
    try {
      const st = await readStealth(new Blob([buf], { type: meta.mime }));
      if (st) meta = mergeStealth(meta, st);
    } catch (err) {
      meta.notes.push(`픽셀 정보 검사 실패: ${err.message}`);
    }
  }
  return meta;
}

async function readStealth(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bmp;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const { data } = ctx.getImageData(0, 0, width, height);
  return decodeStealth(data, width, height);
}

// ───────────── 결과 영역 ─────────────
const savedFiles = [];
function genFiles() {
  const all = aliveFiles();
  return settings.zipAll ? all.slice() : all.filter((f) => f.hasGen);
}
function syncEmpty() {
  const has = !!$('#results .card');
  $('#empty').hidden = has;
  $('#clear-results').hidden = !has;
  const n = genFiles().length;
  $('#save-all').hidden = n === 0;
  const gn = aliveFiles().filter((f) => f.hasGen).length;
  $('#gallery-btn').hidden = gn === 0;
  if (gn === 0 && !$('#gallery').hidden) { $('#gallery').hidden = true; $('#gallery-btn').classList.remove('on'); $('#gallery-btn').setAttribute('aria-expanded', 'false'); }
  $('#gallery-btn').textContent = $('#gallery').hidden ? `갤러리 보기 (${gn})` : `갤러리 접기 (${gn})`;
  renderGallery();
  $('#save-all').textContent = settings.zipAll ? `원본 ${n}개 모두 ZIP 저장` : `생성 정보 있는 원본 ${n}개 ZIP 저장`;
}
// ───────────── 갤러리 (생성 정보가 있는 이미지만) ─────────────
function aliveFiles() {
  for (let i = savedFiles.length - 1; i >= 0; i--) if (!savedFiles[i].card.isConnected) savedFiles.splice(i, 1);
  return savedFiles;
}
function setGallery(open) {
  $('#gallery').hidden = !open;
  $('#gallery-btn').setAttribute('aria-expanded', String(open));
  $('#gallery-btn').classList.toggle('on', open);
  syncEmpty();
}
function renderGallery() {
  const g = $('#gallery');
  if (g.hidden) return;
  const files = aliveFiles().filter((f) => f.hasGen);
  g.replaceChildren(...files.map((f) => h('figure', { class: 'g-tile' },
    h('button', { class: 'g-img', type: 'button', title: '결과로 이동', onclick: () => jumpTo(f) },
      h('img', { src: f.blobUrl, alt: f.prompt.slice(0, 120) || f.title, loading: 'lazy' })),
    h('figcaption', {},
      h('b', {}, f.title),
      h('span', { class: 'g-meta' }, [f.source, f.size].filter(Boolean).join(' · ')),
      f.prompt ? h('span', { class: 'g-prompt' }, f.prompt) : null,
      h('span', { class: 'g-act' },
        copyBtn(f.prompt || f.title, '프롬프트 복사'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => download(f.name, new Blob([f.bytes])) }, '저장'))))));
}
function jumpTo(f) {
  f.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.card.classList.remove('flash');
  void f.card.offsetWidth;
  f.card.classList.add('flash');
}

function saveAllZip() {
  const files = genFiles();
  if (!files.length) return;
  if (files.length === 1) { download(files[0].name, new Blob([files[0].bytes])); return; }
  // 생성 정보 없는 파일이 섞이면 이름 앞에 표시를 붙여 구분한다
  const mark = settings.zipAll && files.some((f) => !f.hasGen);
  const zip = makeZip(files.map((f) => ({ name: mark && !f.hasGen ? `no-meta_${f.name}` : f.name, data: f.bytes })));
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  download(`meta_originals_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`, new Blob([zip], { type: 'application/zip' }));
}
function addCard(card) { $('#results').prepend(card); syncEmpty(); }
function removeCard(card) { card.remove(); syncEmpty(); }

// ───────────── 카드: URL ─────────────

const queue = { running: 0, items: [] };
function enqueue(fn) {
  return new Promise((resolve) => {
    queue.items.push(async () => { try { resolve(await fn()); } finally { queue.running--; pump(); } });
    pump();
  });
}
function pump() { while (queue.running < 3 && queue.items.length) { queue.running++; queue.items.shift()(); } }

function statusText(entry) {
  if (entry.ok) {
    const ct = entry.headers?.['content-type'] || '';
    const pol = entry.headers?.['cf-polished'] ? ` · cf-polished: ${entry.headers['cf-polished']}` : '';
    return { cls: 'ok', text: `✔ ${entry.status} ${ct}${pol} (${entry.via})` };
  }
  if (entry.cors) return { cls: 'warn', text: `⚠ 읽기 차단(CORS/네트워크) (${entry.via})` };
  return { cls: 'err', text: `✖ HTTP ${entry.status}${entry.msg ? ` ${entry.msg.slice(0, 60)}` : ''} (${entry.via})` };
}

function urlCard(parsed, descriptions = []) {
  const results = $('#results');
  const card = h('article', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('div', {},
      h('h2', {}, parsed.title || parsed.uuid || '이미지'),
      h('div', { class: 'src' }, parsed.input)),
    h('button', { class: 'x-btn', type: 'button', onclick: () => removeCard(card), 'aria-label': '닫기' }, '✕')));
  if (parsed.kind) card.append(h('div', { class: 'tags' }, h('span', { class: 'tag on' }, parsed.kind), parsed.v ? h('span', { class: 'tag' }, `v=${parsed.v}`) : null));
  for (const d of descriptions) card.append(h('div', { class: 'note info' }, h('b', {}, `${d.key}: `), d.value));

  const candState = h('span', { class: 'grow' }, '가져오는 중…');
  const candBox = h('details', { class: 'raw cands-box' },
    h('summary', {}, h('b', {}, `후보 주소 ${parsed.candidates.length}개`), candState));
  const tbl = h('table', { class: 'cands' });
  const rows = parsed.candidates.map((c, i) => {
    const st = h('span', { class: 'st wait' }, '대기');
    const img = h('span', { class: 'st wait' }, '');
    const tr = h('tr', {},
      h('td', { class: 'lab' }, `${i + 1}. ${c.label}`),
      h('td', { class: 'u' }, h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.url), c.note ? h('div', { class: 'muted' }, c.note) : null),
      h('td', {}, st, h('br'), img));
    tbl.append(tr);
    return { c, st, img };
  });
  candBox.append(h('div', { class: 'body' }, tbl));
  card.append(candBox);
  const body = h('div', {});
  card.append(body);
  addCard(card);

  enqueue(async () => {
    const report = { input: parsed.input, uuid: parsed.uuid, candidates: [] };
    let firstLoadable = null, anyCors = false, done = false, okCount = 0;
    for (const r of rows) {
      const rep = { url: r.c.url, label: r.c.label, attempts: [] };
      report.candidates.push(rep);
      if (done) { r.st.textContent = '건너뜀'; continue; }
      r.st.textContent = '가져오는 중…';
      // img 로 존재 여부를 병렬 확인
      const probeP = probeImg(r.c.url).then((p) => {
        rep.imgLoad = p.ok;
        r.img.className = `st ${p.ok ? 'ok' : 'err'}`;
        r.img.textContent = p.ok ? `🖼 img 로드 OK ${p.w}×${p.h}` : '🖼 img 로드 실패';
        if (p.ok && !firstLoadable) firstLoadable = r.c.url;
        return p;
      });
      const { got, log } = await fetchCandidate(r.c.url);
      rep.attempts = log;
      const last = statusText(log.at(-1) || { cors: true, via: '-' });
      r.st.className = `st ${last.cls}`;
      r.st.textContent = last.text;
      if (log.some((l) => l.cors)) anyCors = true;
      if (!got) { await probeP; continue; }
      okCount++;
      candState.textContent = `${rows.indexOf(r) + 1}번 ${r.c.label}에서 받음`;
      const meta = await analyzeBytes(got.buf);
      rep.result = { format: meta.format, size: meta.size, hasGenerationInfo: meta.hasGenerationInfo };
      const sec = h('section', {}, h('h3', {}, `${r.c.label} 분석 결과`));
      body.append(sec);
      renderMeta(sec, meta, {
        bytes: got.buf, sourceLabel: r.c.url, derived: !!r.c.derived, saveStem: saveStemFor(parsed, r.c),
        exportBase: `meta_${parsed.uuid || slug(parsed.title)}_${slug(r.c.kind || r.c.label)}`,
      });
      if (meta.format !== 'HTML' && !settings.tryAll) done = true;
      await probeP;
    }
    if (!okCount) {
      candState.textContent = '받지 못함';
      candBox.open = true;
      const box = h('div', { class: 'note warn' },
        h('b', {}, anyCors ? '브라우저 보안(CORS) 때문에 파일 내용을 읽지 못했습니다.' : '어느 후보에서도 파일을 받지 못했습니다.'));
      if (anyCors) {
        box.append(
          h('p', {}, '① 원본을 새 탭에서 열고 “다른 이름으로 저장”한 뒤, 파일 상자에 끌어다 놓으세요. ',
            h('a', { class: 'btn sm', href: (firstLoadable || parsed.candidates[0].url), target: '_blank', rel: 'noopener noreferrer' }, '원본 새 탭에서 열기')),
          h('p', {}, '② 또는 “가져오기 설정”에 CORS 프록시(README 의 Cloudflare Worker) 주소를 넣고 다시 시도하세요.'));
      }
      body.append(box);
      if (firstLoadable) {
        body.append(h('div', { class: 'result' },
          h('div', { class: 'preview' }, h('img', { src: firstLoadable, alt: '원본 후보 미리보기', referrerpolicy: 'no-referrer' })),
          h('div', {}, h('p', { class: 'muted' }, '표시 가능한 가장 우선순위 높은 주소'),
            h('p', {}, h('a', { href: firstLoadable, target: '_blank', rel: 'noopener noreferrer' }, firstLoadable)),
            h('p', { class: 'muted' }, '미리보기는 <img> 로만 보이는 것이고, 메타데이터는 파일 바이트를 읽어야 확인할 수 있습니다.'))));
      }
    }
    body.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => download(`meta_${parsed.uuid || slug(parsed.title)}_candidates.json`, JSON.stringify(report, null, 2)) }, '후보 상태 JSON 다운로드')));
  });
}

// ───────────── 카드: 파일 ─────────────

async function fileCard(file, origin = '') {
  const card = h('article', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('div', {}, h('h2', {}, file.name || '붙여넣은 이미지'), h('div', { class: 'src' }, `${origin ? origin + ' · ' : ''}${file.type || '형식 미상'} · ${fmtSize(file.size)}`)),
    h('button', { class: 'x-btn', type: 'button', onclick: () => removeCard(card), 'aria-label': '닫기' }, '✕')));
  addCard(card);
  const buf = await file.arrayBuffer();
  const meta = await analyzeBytes(buf);
  const base = (file.name || 'image').replace(/\.[^.]+$/, '');
  // 파일 이름에 이미지 uuid 가 있으면 종류를 알려 준다
  const p = parseCaveduckUrl(file.name || '');
  renderMeta(card, meta, { bytes: buf, sourceLabel: origin || `파일: ${file.name || '(붙여넣기)'}`, derived: ['charim-standard', 'charim-160x160', 'charim-1920x'].includes(p?.kind), exportBase: `${base}_meta`, saveStem: base });
}

// ───────────── 카드: HTML 추출 ─────────────

function htmlCard(found) {
  const card = h('article', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('div', {}, h('h2', {}, `페이지 소스에서 이미지 ${found.length}개를 찾았어요`),
      h('p', { class: 'muted' }, '같은 이미지는 하나로 합쳤어요. 항목마다 원본 찾기를 누르세요.')),
    h('button', { class: 'x-btn', type: 'button', onclick: () => removeCard(card), 'aria-label': '닫기' }, '✕')));
  const list = h('div', { class: 'list' });
  for (const f of found) {
    const thumb = f.uuid ? `https://cdn.caveduck.io/charim-160x160/${f.uuid}` : f.urls[0];
    list.append(h('div', { class: 'item' },
      h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'meta' },
        ...f.descriptions.map((d) => h('div', { class: 'desc' }, `${d.key === 'imageNameInternal' ? '' : d.key + ': '}${d.value}`)),
        h('div', { class: 'u' }, f.uuid || f.urls[0]),
        h('div', { class: 'muted' }, f.uuid ? `${f.urls.length}개 주소 · ${[...new Set(f.urls.map((u) => parseCaveduckUrl(u)?.kind).filter(Boolean))].join(', ')}` : f.parsed.site),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => urlCard(f.parsed, f.descriptions) }, '원본 찾기'),
          copyBtn(() => f.urls.join('\n'), '주소 복사')))));
  }
  card.append(list);
  card.append(h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: 'primary', onclick: () => [...found].reverse().forEach((f) => urlCard(f.parsed, f.descriptions)) }, '모두 분석'),
    copyBtn(() => found.map((f) => f.parsed.candidates[0].url).join('\n'), '원본 후보 주소 모두 복사'),
    h('button', { class: 'btn', type: 'button', onclick: () => download('meta_images.json', JSON.stringify(found.map(({ uuid, urls, descriptions, parsed }) => ({ uuid, urls, descriptions, candidates: parsed.candidates.map((c) => c.url) })), null, 2)) }, '목록 JSON 다운로드')));
  addCard(card);
}

// ───────────── 입력 처리 ─────────────

function findImagesInHtml(text) {
  return [...extractFromHtml(text), ...extractGenericImages(text)];
}

function run() {
  const text = $('#input').value;
  if (!text.trim()) { toast('주소를 입력하세요'); return; }
  if (looksLikeHtml(text)) {
    const found = findImagesInHtml(text);
    if (!found.length) { toast('이미지 주소를 찾지 못했습니다'); return; }
    htmlCard(found);
    return;
  }
  const items = parseLines(text);
  // data:image/... 값은 이미지 바이트가 들어 있으므로 파일처럼 바로 분석
  const datas = items.filter((x) => x.dataUrl);
  const seenData = new Set();
  for (const d of [...datas].reverse()) {
    if (seenData.has(d.normalized)) continue;
    seenData.add(d.normalized);
    const ext = (d.mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
    fileCard(new File([d.bytes], `data_image_${seenData.size}.${ext}`, { type: d.mime }), '붙여 넣은 data: 값')
      .catch((err) => toast(`data: 값 읽기 실패: ${err.message}`));
  }
  const bad = items.filter((x) => x.error);
  // 같은 UUID 는 한 번만
  const seen = new Set();
  const good = items.filter((x) => { if (x.error || x.dataUrl) return false; const k = x.uuid || x.normalized; return seen.has(k) ? false : (seen.add(k), true); });
  [...good].reverse().forEach((p) => urlCard(p));
  if (bad.length) toast(`${bad.length}줄은 이미지 주소(https://…)가 아니라서 건너뛰었어요`);
}

let HINT0 = '';
function updateHint() {
  const t = $('#input').value;
  if (!t.trim()) { $('#modeHint').textContent = HINT0; return; }
  if (looksLikeHtml(t)) $('#modeHint').textContent = `HTML 소스 모드 · 이미지 ${findImagesInHtml(t).length}개 감지`;
  else {
    const items = parseLines(t);
    const nd = items.filter((x) => x.dataUrl).length;
    const ok = items.filter((x) => !x.error && !x.dataUrl).length;
    const bad = items.length - ok - nd;
    $('#modeHint').textContent = [ok ? `주소 ${ok}개 인식` : '', nd ? `이미지 데이터(data:) ${nd}개` : '', bad ? `${bad}줄 인식 불가` : ''].filter(Boolean).join(' · ') || '인식된 주소 없음';
  }
}

function handleFiles(files) {
  for (const f of files) fileCard(f).catch((err) => toast(`파일 읽기 실패: ${err.message}`));
}

function initTheme() {
  const apply = (mode) => {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    for (const b of document.querySelectorAll('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === (mode || 'auto'));
  };
  apply(store.get('cdm.theme', 'auto'));
  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.addEventListener('click', () => { apply(b.dataset.themeSet); store.set('cdm.theme', b.dataset.themeSet); });
  }
}

function init() {
  HINT0 = $('#modeHint').textContent;
  initTheme();
  initSettings();
  $('#runBtn').addEventListener('click', run);
  $('#clearBtn').addEventListener('click', () => { $('#input').value = ''; updateHint(); $('#input').focus(); });
  $('#save-all').addEventListener('click', saveAllZip);
  $('#gallery-btn').addEventListener('click', () => setGallery($('#gallery').hidden));
  $('#copy-snippet').addEventListener('click', () => { copyText(GALLERY_SNIPPET); $('#snippet-help').hidden = false; });
  $('#snippet-help-close').addEventListener('click', () => { $('#snippet-help').hidden = true; });
  $('#clear-results').addEventListener('click', () => { for (const c of document.querySelectorAll('#results .card')) c.remove(); syncEmpty(); });
  $('#settings-btn').addEventListener('click', () => {
    const d = $('#settings'); d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => $('#proxy').focus({ preventScroll: true }), 300);
  });
  $('#input').addEventListener('input', updateHint);
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });

  const drop = $('#drop'), fi = $('#fileInput');
  drop.addEventListener('click', () => fi.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
  for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    else {
      const t = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
      if (t) { $('#input').value = t; updateHint(); run(); }
    }
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); handleFiles(files); }
  });

  // ?url=… 로 바로 분석
  const q = new URLSearchParams(location.search).get('url');
  if (q) { $('#input').value = q; updateHint(); run(); }
}

init();
