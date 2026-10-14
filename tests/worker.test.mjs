// Worker 로직을 fetch 를 바꿔치기해서 검증한다 (실제 네트워크 사용 안 함)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkTarget } from '../worker/worker.js';

let calls;
beforeEach(() => { calls = []; });
const mockFetch = (handler) => { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); }; };
const req = (target, init = {}) => new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`, init);
const UUID = 'a1723c53-fe6f-4a8f-b058-13b84e0781ad';

test('허용 호스트만 통과', () => {
  assert.ok(checkTarget(`https://cdn.caveduck.io/charim/${UUID}`).url);
  for (const bad of ['http://cdn.caveduck.io/x', 'https://evil.com/x', 'https://cdn.caveduck.io.evil.com/x',
    'https://user@cdn.caveduck.io/x', 'https://cdn.caveduck.io:8443/x', 'not a url']) {
    assert.ok(checkTarget(bad).error, bad);
  }
});

test('정상 전달 + CORS 헤더 + Accept 고정', async () => {
  mockFetch(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png', 'cf-polished': 'origSize=1' } }));
  const res = await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`, { headers: { Origin: 'https://me.github.io' } }), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cf-polished'), 'origSize=1');
  assert.equal((await res.arrayBuffer()).byteLength, 4);
  assert.equal(calls[0].init.headers.Accept, '*/*');
});

test('다른 호스트 거부', async () => {
  mockFetch(() => { throw new Error('호출되면 안 됨'); });
  const res = await worker.fetch(req('https://example.com/a.png'), {});
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('허용 Origin 목록', async () => {
  mockFetch(() => new Response('x'));
  const env = { ALLOWED_ORIGINS: 'https://me.github.io' };
  const ok = await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`, { headers: { Origin: 'https://me.github.io' } }), env);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://me.github.io');
  const no = await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`, { headers: { Origin: 'https://other.io' } }), env);
  assert.equal(no.status, 403);
});

test('크기 제한: Content-Length / 스트리밍', async () => {
  mockFetch(() => new Response(new Uint8Array(100), { headers: { 'Content-Length': '100' } }));
  assert.equal((await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`), { MAX_BYTES: '50' })).status, 413);
  mockFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40)); c.enqueue(new Uint8Array(40)); c.close(); } })));
  assert.equal((await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`), { MAX_BYTES: '50' })).status, 413);
});

test('외부 호스트로의 리다이렉트 거부', async () => {
  mockFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.com/x' } }));
  const res = await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`), {});
  assert.equal(res.status, 502);
});

test('업스트림 404 전달', async () => {
  mockFetch(() => new Response('nf', { status: 404 }));
  const res = await worker.fetch(req(`https://cdn.caveduck.io/charim/${UUID}`), {});
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-upstream-status'), '404');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS 프리플라이트', async () => {
  const res = await worker.fetch(new Request('https://proxy.example/?url=x', { method: 'OPTIONS' }), {});
  assert.equal(res.status, 204);
});
