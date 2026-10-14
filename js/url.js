// caveduck.io 이미지 주소 → 원본 후보 주소 변환, HTML 소스에서 이미지 주소 추출.
// 브라우저와 Node(테스트) 양쪽에서 쓰는 순수 함수 모음.

export const CDN_HOST = 'cdn.caveduck.io';
export const KINDS = ['charim', 'charim-1920x', 'charim-standard', 'charim-160x160'];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const KIND_LABEL = {
  'charim': '업로드 원본(추정)',
  'charim-1920x': '1920px 리사이즈',
  'charim-standard': '640px WebP (표준)',
  'charim-160x160': '160×160 썸네일',
};

/** 붙여넣기 과정에서 딸려 온 따옴표·파이프·괄호·공백 등을 정리한다. */
export function cleanInput(s) {
  let t = String(s ?? '').trim();
  t = t.replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
  // 앞쪽 잡동사니
  t = t.replace(/^[\s|'"`<(\[{]+/, '');
  // 뒤쪽 잡동사니
  t = t.replace(/[\s|'"`>)\]},;\\]+$/, '');
  // 마크다운 이미지 ![..](url) 등 중간에 URL이 박혀 있으면 URL만 꺼낸다
  const m = t.match(/https?:\/\/[^\s|'"`<>()\[\]{}\\]+/);
  if (m) t = m[0];
  return t.replace(/[.,;]+$/, '');
}

/**
 * caveduck 이미지 URL(또는 "charim-standard/<uuid>" 같은 경로)을 분석한다.
 * @returns {null | {input, uuid, kind, v, normalized, candidates: {url, kind, label, note}[]}}
 */
export function parseCaveduckUrl(raw) {
  const input = cleanInput(raw);
  if (!input) return null;

  let pathPart = input;
  let query = '';
  let host = CDN_HOST;
  if (/^https?:\/\//i.test(input)) {
    let u;
    try { u = new URL(input); } catch { return null; }
    host = u.hostname.toLowerCase();
    pathPart = u.pathname;
    query = u.search;
  } else {
    const q = input.indexOf('?');
    if (q >= 0) { query = input.slice(q); pathPart = input.slice(0, q); }
  }
  if (host !== CDN_HOST && !host.endsWith('.caveduck.io')) return null;

  // Cloudflare 이미지 리사이즈 접두사 제거: /cdn-cgi/image/<옵션>/<원래경로>
  let path = pathPart.replace(/^\/+/, '');
  path = path.replace(/^cdn-cgi\/image\/[^/]*\//, '');
  // 원래 경로가 절대 URL로 들어간 경우(/cdn-cgi/image/opts/https://cdn.caveduck.io/charim/..)
  path = path.replace(/^https?:\/+[^/]+\//, '');

  const v = new URLSearchParams(query).get('v') || '';
  const m = path.match(/^(charim(?:-[a-z0-9x]+)*)\/([0-9a-f-]{36})/i);
  const uuidOnly = path.match(UUID_RE);

  if (!m) {
    if (!uuidOnly) {
      if (!/^https?:\/\//i.test(input)) return null;
      // caveduck CDN이긴 하지만 charim 계열이 아님: 리사이즈만 뗀 주소 하나로 처리
      const url = `https://${CDN_HOST}/${path}${query}`;
      return { input, uuid: null, kind: null, v, normalized: url,
        candidates: [{ url, kind: null, label: '리사이즈 제거 주소', note: '' }] };
    }
  }
  const kind = m ? m[1].toLowerCase() : null;
  const uuid = (m ? m[2] : uuidOnly[0]).toLowerCase();
  if (!UUID_RE.test(uuid)) return null;

  const q = (vv) => (vv ? `?v=${encodeURIComponent(vv)}` : '');
  const mk = (k, vv, note = '') => ({
    url: `https://${CDN_HOST}/${k}/${uuid}${q(vv)}`,
    kind: k,
    label: KIND_LABEL[k] || k,
    note,
  });

  // v 값이 charim-standard/160x160(변환본)에서 왔으면 짧은 캐시 해시일 뿐이므로
  // 원본(charim/)에는 v 없는 주소를 먼저 시도한다.
  const vFromDerived = !!v && (kind === null || kind === 'charim-standard' || kind === 'charim-160x160' || !KINDS.includes(kind));
  const list = [];
  if (v && !vFromDerived) {
    list.push(mk('charim', v, '원래 v 값 유지'));
    list.push(mk('charim', '', 'v 없음'));
  } else {
    list.push(mk('charim', '', 'v 없음'));
    if (v) list.push(mk('charim', v, '원래 v 값'));
  }
  list.push(mk('charim-1920x', ''));
  if (v) list.push(mk('charim-1920x', v));
  list.push(mk('charim-standard', ''));
  if (v && kind === 'charim-standard') list.push(mk('charim-standard', v, '입력 주소(리사이즈 제거)'));
  list.push(mk('charim-160x160', ''));
  if (v && kind === 'charim-160x160') list.push(mk('charim-160x160', v, '입력 주소(리사이즈 제거)'));
  // 알 수 없는 charim-* 종류라면 입력 주소 자체도 후보에 넣는다
  if (kind && !KINDS.includes(kind)) list.push(mk(kind, v, '입력 주소(리사이즈 제거)'));

  const seen = new Set();
  const candidates = list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  const normalized = kind ? `https://${CDN_HOST}/${kind}/${uuid}${q(v)}` : candidates[0].url;
  return { input, uuid, kind, v, normalized, candidates };
}

/** 여러 줄 입력을 각 줄 단위로 분석한다. 실패한 줄은 error 로 표시. */
export function parseLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const r = parseImageUrl(line);
      return r ? r : { input: line, error: '이미지 주소(https://…)로 인식할 수 없음' };
    });
}

/** 붙여넣은 내용이 HTML/JSON 페이지 소스처럼 보이는지 */
export function looksLikeHtml(text) {
  const t = String(text ?? '');
  if (/<(html|head|body|script|div|img|meta)[\s>]/i.test(t)) return true;
  if (/__NEXT_DATA__|self\.__next_f/.test(t)) return true;
  // 한 줄에 URL 여러 개 + 따옴표/중괄호(JSON 등)
  const n = (t.match(/cdn\.caveduck\.io/g) || []).length;
  return n >= 2 && /["{}]/.test(t) && t.split(/\n/).length < n * 2;
}

function unescapeJsonish(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+"/g, '"')
    .replace(/\\+\//g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&amp;/g, '&');
}

const DESC_KEYS = ['imageNameInternal', 'imageName', 'imageDescription', 'imageCaption', 'imagePrompt', 'alt'];

/**
 * HTML/JSON 페이지 소스에서 cdn.caveduck.io 이미지 주소를 모두 뽑고, UUID 단위로 묶는다.
 * 근처에 imageNameInternal 등 설명 필드가 있으면 descriptions 로 붙인다.
 * @returns {{uuid, urls: string[], descriptions: {key, value}[], parsed}[]}
 */
export function extractFromHtml(html) {
  const src = unescapeJsonish(String(html ?? ''));
  const byUuid = new Map();
  const positions = []; // {uuid, pos}

  const add = (uuid, url, pos) => {
    uuid = uuid.toLowerCase();
    if (!byUuid.has(uuid)) byUuid.set(uuid, { uuid, urls: [], descriptions: [], firstPos: pos });
    const e = byUuid.get(uuid);
    if (url && !e.urls.includes(url)) e.urls.push(url);
    positions.push({ uuid, pos });
  };

  // 1) 완전한 URL
  const urlRe = /https?:\/\/cdn\.caveduck\.io\/[^\s"'<>\\)`]+/gi;
  for (const m of src.matchAll(urlRe)) {
    const p = parseCaveduckUrl(m[0]);
    if (p && p.uuid) add(p.uuid, cleanInput(m[0]), m.index);
  }
  // 2) 호스트 없이 "charim-standard/<uuid>" 형태로만 들어간 참조
  const pathRe = /(?:^|[^\w.-])(charim(?:-[a-z0-9x]+)*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const m of src.matchAll(pathRe)) {
    const url = `https://${CDN_HOST}/${m[1]}/${m[2].toLowerCase()}`;
    add(m[2], byUuid.has(m[2].toLowerCase()) ? null : url, m.index);
  }

  // 3) 설명 필드 → 가장 가까운 이미지 UUID 에 연결
  const keyRe = new RegExp(`"(${DESC_KEYS.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,2000}?)"`, 'g');
  for (const m of src.matchAll(keyRe)) {
    const value = m[2].trim();
    if (!value || /^https?:\/\//.test(value)) continue;
    // 같은 객체 안일 가능성이 높은 ±3000자 안에서 가장 가까운 UUID
    let best = null;
    for (const p of positions) {
      const d = Math.abs(p.pos - m.index);
      if (d < 3000 && (!best || d < best.d)) best = { uuid: p.uuid, d };
    }
    // 이미지 주소 대신 같은 객체에 uuid 필드만 있는 경우
    if (!best) {
      const win = src.slice(Math.max(0, m.index - 1500), m.index + 1500);
      const u = win.match(UUID_RE);
      if (u && byUuid.has(u[0].toLowerCase())) best = { uuid: u[0].toLowerCase(), d: 0 };
    }
    if (best) {
      const e = byUuid.get(best.uuid);
      if (!e.descriptions.some((x) => x.key === m[1] && x.value === value)) e.descriptions.push({ key: m[1], value });
    }
  }

  return [...byUuid.values()]
    .sort((a, b) => a.firstPos - b.firstPos)
    .map(({ uuid, urls, descriptions }) => {
      const parsed = parseCaveduckUrl(urls[0] || `https://${CDN_HOST}/charim/${uuid}`);
      return { uuid, urls, descriptions, parsed };
    });
}

// ───────────── caveduck 외 사이트 (티스토리·노션·일반 이미지 주소) ─────────────

function safeDecode(s) {
  let t = s;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(t); i++) {
    try { t = decodeURIComponent(t); } catch { break; }
  }
  return t;
}

function fileNameOf(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    return p.length ? safeDecode(p[p.length - 1]) : new URL(url).hostname;
  } catch { return url; }
}

/**
 * 일반 이미지 주소 → 원본 후보.
 * - 티스토리: i1.daumcdn.net/thumb/...?fname=<원본> → 원본(blog.kakaocdn.net/dn/...) 먼저, cfile 은 ?original
 * - 노션: notion.so/image/<원본> 또는 *.notion.site/image/<원본> → 원본(S3), 크기 지정 없는 프록시 주소
 * - 그 밖: Cloudflare /cdn-cgi/image/<옵션>/ 리사이즈를 떼어 낸 주소 → 입력 주소
 */
export function parseGenericUrl(raw) {
  const input = cleanInput(raw);
  if (!/^https?:\/\//i.test(input)) return null;
  let u;
  try { u = new URL(input); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const list = [];
  const add = (url, label, note = '', derived = false) => { if (url) list.push({ url, kind: null, label, note, derived }); };
  let site = '이미지';

  if (/(^|\.)daumcdn\.net$/.test(host) || /(^|\.)kakaocdn\.net$/.test(host) || /(^|\.)tistory\.com$/.test(host)) {
    site = '티스토리';
    const fname = u.searchParams.get('fname');
    if (fname) {
      const orig = safeDecode(fname).replace(/^http:\/\//i, 'https://');
      add(orig, '원본(fname 에서 추출)');
      add(input, '입력 주소(썸네일)', '', true);
    } else if (/^\/cfile\/tistory\//i.test(u.pathname)) {
      add(`${u.origin}${u.pathname}?original`, '원본(?original)');
      add(input, '입력 주소', '', true);
    } else {
      add(input, '입력 주소');
    }
  } else if (/(^|\.)notion\.so$/.test(host) || /\.notion\.site$/.test(host)) {
    site = '노션';
    const m = u.pathname.match(/^\/image\/(.+)$/);
    if (m) {
      const inner = safeDecode(m[1]);
      if (/^https?:\/\//i.test(inner)) add(inner, '원본(S3, 서명 필요할 수 있음)');
      const full = new URL(input);
      full.searchParams.delete('width');
      full.searchParams.delete('cache');
      add(full.toString(), '노션 원본 크기', 'width 파라미터 제거');
      add(input, '입력 주소', '', true);
    } else {
      add(input, '입력 주소');
    }
  } else if (/amazonaws\.com$/.test(host) && /notion/.test(input) || /notionusercontent\.com$/.test(host)) {
    site = '노션';
    add(input, '입력 주소');
  } else {
    site = host.replace(/^www\./, '');
    const cf = u.pathname.match(/^\/cdn-cgi\/image\/[^/]*\/(.+)$/);
    if (cf) {
      const rest = cf[1];
      add(/^https?:\/\//i.test(rest) ? rest : `${u.origin}/${rest}${u.search}`, '리사이즈 제거');
      add(input, '입력 주소(리사이즈)', '', true);
    } else {
      add(input, '입력 주소');
    }
  }
  const seen = new Set();
  const candidates = list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  return { input, uuid: null, kind: site, site, v: '', title: `${site} · ${fileNameOf(candidates[0].url)}`, normalized: candidates[0].url, candidates };
}

/** caveduck 이면 전용 규칙, 아니면 일반 규칙 */
export function parseImageUrl(raw) {
  const c = parseCaveduckUrl(raw);
  if (c) {
    for (const x of c.candidates) x.derived = x.kind === 'charim-standard' || x.kind === 'charim-160x160' || x.kind === 'charim-1920x';
    return { ...c, site: 'caveduck', title: c.uuid || c.input };
  }
  return parseGenericUrl(raw);
}

/** HTML 소스의 일반 이미지(<img src>, data-src, srcset, og:image) 추출 */
export function extractGenericImages(html, limit = 300) {
  const src = String(html ?? '');
  const out = new Map();
  const push = (url, alt) => {
    const clean = cleanInput(url.replace(/&amp;/g, '&'));
    if (!/^https?:\/\//i.test(clean) || /\.(svg|ico)(\?|$)/i.test(clean) || /cdn\.caveduck\.io/i.test(clean)) return;
    if (out.size >= limit && !out.has(clean)) return;
    const e = out.get(clean) || { key: clean, urls: [clean], descriptions: [] };
    if (alt && !e.descriptions.some((d) => d.value === alt)) e.descriptions.push({ key: 'alt', value: alt });
    out.set(clean, e);
  };
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = (tag.match(/\balt\s*=\s*"([^"]*)"/i) || [])[1]?.trim();
    for (const a of ['data-original', 'data-src', 'data-url', 'src']) {
      const v = tag.match(new RegExp(`\\b${a}\\s*=\\s*"([^"]+)"`, 'i'));
      if (v) { push(v[1], alt); break; }
    }
    const ss = tag.match(/\bsrcset\s*=\s*"([^"]+)"/i);
    if (ss) {
      const best = ss[1].split(',').map((s) => s.trim().split(/\s+/)).sort((a, b) => parseFloat(b[1] || 0) - parseFloat(a[1] || 0))[0];
      if (best) push(best[0], alt);
    }
  }
  for (const m of src.matchAll(/<meta\b[^>]*(?:og:image|twitter:image)[^>]*>/gi)) {
    const v = m[0].match(/\bcontent\s*=\s*"([^"]+)"/i);
    if (v) push(v[1], '대표 이미지');
  }
  return [...out.values()].map((e) => ({ ...e, uuid: null, parsed: parseGenericUrl(e.urls[0]) })).filter((e) => e.parsed);
}
