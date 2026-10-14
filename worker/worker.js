// Cloudflare Worker: cdn.caveduck.io 전용 CORS 프록시
//   GET https://<worker>/?url=https://cdn.caveduck.io/charim/<uuid>
//
// 환경 변수(선택, wrangler.toml [vars] 또는 대시보드에서 설정):
//   ALLOWED_ORIGINS  쉼표로 구분한 허용 Origin 목록. 예: "https://me.github.io,http://localhost:8000"
//                    비우거나 "*" 이면 모든 Origin 허용
//   MAX_BYTES        최대 전달 크기(바이트). 기본 26214400 (25 MiB)

const ALLOWED_HOSTS = new Set(['cdn.caveduck.io']);
const DEFAULT_MAX = 25 * 1024 * 1024;
const PASS_HEADERS = ['content-type', 'last-modified', 'etag', 'cf-polished', 'cf-cache-status', 'cf-resized'];
const MAX_REDIRECTS = 3;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const h = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  if (!allowed.length || allowed.includes('*')) h.set('Access-Control-Allow-Origin', '*');
  else if (allowed.includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  return { headers: h, originOk: !allowed.length || allowed.includes('*') || allowed.includes(origin) };
}

function fail(status, message, cors) {
  const h = new Headers(cors);
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(message, { status, headers: h });
}

/** 허용된 https 주소만 통과시킨다 */
export function checkTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: 'url 파라미터가 올바른 주소가 아닙니다' }; }
  if (u.protocol !== 'https:') return { error: 'https 주소만 허용됩니다' };
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return { error: `허용되지 않은 호스트: ${u.hostname}` };
  if (u.username || u.password || (u.port && u.port !== '443')) return { error: '사용자 정보나 포트가 들어간 주소는 허용되지 않습니다' };
  return { url: u };
}

export default {
  async fetch(request, env = {}) {
    const { headers: cors, originOk } = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'GET 만 지원합니다', cors);
    if (!originOk) return fail(403, '허용되지 않은 Origin 입니다', cors);

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) return fail(400, '사용법: ?url=https://cdn.caveduck.io/charim/<uuid>', cors);
    let { url, error } = checkTarget(target);
    if (error) return fail(400, error, cors);

    const max = Number(env.MAX_BYTES) > 0 ? Number(env.MAX_BYTES) : DEFAULT_MAX;

    // 리다이렉트는 허용 호스트 안에서만 직접 따라간다
    let upstream;
    for (let i = 0; ; i++) {
      upstream = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        // Accept 를 */* 로 고정: 이미지 최적화(Polish/f=auto)가 WebP/AVIF 로 바꿔 주지 않도록
        headers: { Accept: '*/*', 'User-Agent': 'caveduck-meta-proxy/1.0' },
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      if (i >= MAX_REDIRECTS) return fail(508, '리다이렉트가 너무 많습니다', cors);
      const loc = upstream.headers.get('Location');
      const next = loc ? checkTarget(new URL(loc, url).toString()) : { error: 'Location 없음' };
      if (next.error) return fail(502, `리다이렉트 거부: ${next.error}`, cors);
      url = next.url;
    }

    const out = new Headers(cors);
    for (const k of PASS_HEADERS) { const v = upstream.headers.get(k); if (v) out.set(k, v); }
    out.set('X-Upstream-Status', String(upstream.status));
    out.set('X-Upstream-Url', url.toString());
    out.set('Cache-Control', upstream.ok ? 'public, max-age=3600' : 'no-store');

    const len = Number(upstream.headers.get('Content-Length') || 0);
    if (len > max) return fail(413, `파일이 너무 큽니다 (${len} > ${max} 바이트)`, cors);
    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}`, { status: upstream.status, headers: out });
    }
    if (request.method === 'HEAD') {
      if (len) out.set('Content-Length', String(len));
      return new Response(null, { status: 200, headers: out });
    }

    // Content-Length 가 없거나 거짓이어도 max 를 넘으면 끊는다
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); return fail(413, `파일이 너무 큽니다 (> ${max} 바이트)`, cors); }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { body.set(c, p); p += c.byteLength; }
    out.set('Content-Length', String(total));
    return new Response(body, { status: 200, headers: out });
  },
};
