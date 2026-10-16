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

import { parseImageUrl, extractGenericImages } from '../js/url.js';

test('티스토리 썸네일 → fname 원본 먼저', () => {
  const r = parseImageUrl('https://img1.daumcdn.net/thumb/R1280x0/?scode=mtistory2&fname=https%3A%2F%2Fblog.kakaocdn.net%2Fdn%2FbX1%2FbtsY2%2Fabc%2Fimg.png |');
  assert.equal(r.site, '티스토리');
  assert.equal(r.candidates[0].url, 'https://blog.kakaocdn.net/dn/bX1/btsY2/abc/img.png');
  assert.equal(r.candidates[1].derived, true);
});

test('티스토리 cfile → ?original', () => {
  const r = parseImageUrl('https://t1.daumcdn.net/cfile/tistory/99ABC33F5C');
  assert.equal(r.candidates[0].url, 'https://t1.daumcdn.net/cfile/tistory/99ABC33F5C?original');
});

test('노션 image 프록시 → S3 원본, width 제거', () => {
  const r = parseImageUrl('https://www.notion.so/image/https%3A%2F%2Fprod-files-secure.s3.us-west-2.amazonaws.com%2Fabc%2Fimage.png?table=block&id=1&width=640');
  assert.equal(r.site, '노션');
  assert.equal(r.candidates[0].url, 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/image.png');
  assert.ok(!r.candidates[1].url.includes('width='));
});

test('일반 주소: 그대로, cdn-cgi 리사이즈 제거', () => {
  assert.deepEqual(parseImageUrl('https://pbs.twimg.com/media/x.png').candidates.map((c) => c.url), ['https://pbs.twimg.com/media/x.png']);
  assert.equal(parseImageUrl('https://ex.com/cdn-cgi/image/w=400/pics/a.png').candidates[0].url, 'https://ex.com/pics/a.png');
  assert.equal(parseImageUrl('hello'), null);
});

test('caveduck 주소는 전용 규칙 유지', () => {
  const r = parseImageUrl(EX);
  assert.equal(r.site, 'caveduck');
  assert.equal(r.candidates[0].url, `https://cdn.caveduck.io/charim/${UUID}`);
  assert.equal(r.candidates.find((c) => c.kind === 'charim-standard').derived, true);
});

test('HTML 일반 이미지 추출 (img/data-src/srcset/og:image)', () => {
  const html = `<html><meta property="og:image" content="https://ex.com/og.png">
    <img src="https://ex.com/a.png" alt="첫 그림"><img data-src="https://ex.com/b.jpg" src="data:image/gif;base64,AA">
    <img srcset="https://ex.com/c-1x.png 1x, https://ex.com/c-2x.png 2x"><img src="/rel.png"><img src="https://ex.com/i.svg"></html>`;
  const r = extractGenericImages(html);
  const urls = r.map((x) => x.urls[0]);
  assert.ok(urls.includes('https://ex.com/a.png') && urls.includes('https://ex.com/b.jpg') && urls.includes('https://ex.com/c-2x.png') && urls.includes('https://ex.com/og.png'));
  assert.ok(!urls.some((u) => u.endsWith('.svg') || u.startsWith('data:')));
  assert.equal(r.find((x) => x.urls[0] === 'https://ex.com/a.png').descriptions[0].value, '첫 그림');
});

import { parseDataUrl, parseLines as parseLines2 } from '../js/url.js';

test('Firebase Storage: 토큰 주소 그대로, alt 없으면 alt=media 추가', () => {
  const U = 'https://firebasestorage.googleapis.com/v0/b/lovelog-cc579.firebasestorage.app/o/tsites%2Fjihanull%2F1791690005276_621_20261011101052.jpg?alt=media&token=ab4731d3';
  const r = parseImageUrl(U);
  assert.equal(r.site, 'Firebase');
  assert.deepEqual(r.candidates.map((c) => c.url), [U]);
  assert.equal(r.title, 'Firebase · 1791690005276_621_20261011101052.jpg');
  const r2 = parseImageUrl('https://firebasestorage.googleapis.com/v0/b/x/o/a%2Fb.png?token=t');
  assert.ok(r2.candidates[0].url.includes('alt=media') && r2.candidates[0].url.includes('token=t'));
});

test('data:image 값 → 바이트', () => {
  const d = parseDataUrl(`"data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10]).toString('base64')}"`);
  assert.equal(d.mime, 'image/png');
  assert.deepEqual([...d.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(parseDataUrl('data:image/png;base64,!!!'), null);
  assert.equal(parseDataUrl('https://x/a.png'), null);
  const items = parseLines2('data:image/webp;base64,UklGRg==\nhttps://ex.com/a.png');
  assert.ok(items[0].dataUrl && items[1].candidates);
});
