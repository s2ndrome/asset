import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanInput, parseCaveduckUrl, parseLines, extractFromHtml, looksLikeHtml } from '../js/url.js';

const UUID = 'a1723c53-fe6f-4a8f-b058-13b84e0781ad';
const EX = `https://cdn.caveduck.io/cdn-cgi/image/anim=true,dpr=2,f=auto,w=800/charim-standard/${UUID}?v=47d447`;

test('예시 주소: 리사이즈 제거 + 후보 순서', () => {
  const r = parseCaveduckUrl(EX);
  assert.equal(r.uuid, UUID);
  assert.equal(r.kind, 'charim-standard');
  assert.equal(r.v, '47d447');
  assert.deepEqual(r.candidates.map((c) => c.url), [
    `https://cdn.caveduck.io/charim/${UUID}`,
    `https://cdn.caveduck.io/charim/${UUID}?v=47d447`,
    `https://cdn.caveduck.io/charim-1920x/${UUID}`,
    `https://cdn.caveduck.io/charim-1920x/${UUID}?v=47d447`,
    `https://cdn.caveduck.io/charim-standard/${UUID}`,
    `https://cdn.caveduck.io/charim-standard/${UUID}?v=47d447`,
    `https://cdn.caveduck.io/charim-160x160/${UUID}`,
  ]);
});

test('charim/ 원본에서 온 v 는 먼저 붙여서 시도', () => {
  const r = parseCaveduckUrl(`https://cdn.caveduck.io/charim/${UUID}?v=abcdef0123`);
  assert.equal(r.candidates[0].url, `https://cdn.caveduck.io/charim/${UUID}?v=abcdef0123`);
  assert.equal(r.candidates[1].url, `https://cdn.caveduck.io/charim/${UUID}`);
});

test('v 없는 160x160', () => {
  const r = parseCaveduckUrl(`https://cdn.caveduck.io/charim-160x160/${UUID.toUpperCase()}`);
  assert.equal(r.uuid, UUID);
  assert.equal(r.candidates.length, 4);
  assert.equal(r.candidates[0].url, `https://cdn.caveduck.io/charim/${UUID}`);
});

test('입력 끝 잡동사니 정리', () => {
  for (const s of [`${EX}|`, `'${EX}'`, `"${EX}"  `, ` ${EX} | `, `![img](${EX})`, `<${EX}>`, `${EX}",`]) {
    assert.equal(cleanInput(s), EX, s);
    assert.equal(parseCaveduckUrl(s).uuid, UUID);
  }
});

test('경로만 있는 입력', () => {
  const r = parseCaveduckUrl(`charim-1920x/${UUID}`);
  assert.equal(r.kind, 'charim-1920x');
  assert.equal(r.candidates[0].url, `https://cdn.caveduck.io/charim/${UUID}`);
});

test('caveduck 이 아닌 주소는 null', () => {
  assert.equal(parseCaveduckUrl('https://example.com/charim/' + UUID), null);
  assert.equal(parseCaveduckUrl('hello'), null);
});

test('여러 줄', () => {
  const r = parseLines(`${EX}\n\nhttps://cdn.caveduck.io/charim/${UUID}|\nnot a url`);
  assert.equal(r.length, 3);
  assert.ok(r[0].uuid && r[1].uuid);
  assert.ok(r[2].error);
});

test('HTML 소스에서 추출 + imageNameInternal', () => {
  const U2 = '11111111-2222-3333-4444-555555555555';
  const U3 = '99999999-8888-7777-6666-555555555555';
  const html = `<!DOCTYPE html><html><head><meta property="og:image" content="${EX}"></head><body>
  <img src="https://cdn.caveduck.io/cdn-cgi/image/w=160/charim-160x160/${U2}?v=aa11">
  <script>self.__next_f.push([1,"{\\"images\\":[{\\"imageNameInternal\\":\\"웃는 표정\\",\\"image\\":\\"https:\\/\\/cdn.caveduck.io\\/charim-standard\\/${U2}?v=aa11\\"}]}"])</script>
  <script id="__NEXT_DATA__">{"x":{"path":"charim/${U3}","imageNameInternal":"배경 동굴"}}</script>
  </body></html>`;
  assert.ok(looksLikeHtml(html));
  const r = extractFromHtml(html);
  assert.deepEqual(r.map((x) => x.uuid), [UUID, U2, U3]);
  assert.deepEqual(r[1].descriptions, [{ key: 'imageNameInternal', value: '웃는 표정' }]);
  assert.deepEqual(r[2].descriptions, [{ key: 'imageNameInternal', value: '배경 동굴' }]);
  assert.equal(r[2].parsed.candidates[0].url, `https://cdn.caveduck.io/charim/${U3}`);
  assert.equal(r[0].parsed.v, '47d447');
});

test('평범한 URL 목록은 HTML 로 보지 않음', () => {
  assert.equal(looksLikeHtml(`${EX}\n${EX}`), false);
});
