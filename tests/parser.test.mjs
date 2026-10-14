// node --test tests/  (Node 18+)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseImage, decodeStealth, mergeStealth, parseA1111, decodeUserComment } from '../js/parser.js';

const fx = (n) => readFile(new URL(`./fixtures/${n}`, import.meta.url));
const find = (res, key, src) => res.entries.find((e) => e.key === key && (!src || e.source.includes(src)));

test('PNG tEXt: A1111 parameters', async () => {
  const r = await parseImage(await fx('a1111_text.png'));
  assert.equal(r.format, 'PNG');
  assert.equal(r.width, 8); assert.equal(r.height, 6);
  assert.ok(find(r, 'parameters', 'tEXt'));
  const s = r.summaries.find((x) => x.type === 'SD-WebUI');
  assert.equal(s.negative, 'lowres, bad hands');
  assert.equal(s.params.Steps, '28');
  assert.equal(s.params.Sampler, 'DPM++ 2M Karras');
  assert.equal(s.params['Lora hashes'], 'foo: 1a2b, bar: 3c4d');
  assert.ok(r.hasGenerationInfo);
});

test('PNG iTXt(비압축/압축) + zTXt', async () => {
  const r = await parseImage(await fx('itxt_ztxt.png'));
  const p = find(r, 'parameters', 'iTXt');
  assert.ok(p.value.includes('한국어 프롬프트'));
  assert.equal(p.lang, 'ko');
  assert.equal(p.translatedKey, '매개변수');
  assert.ok(find(r, 'Description', 'iTXt(압축)').value.startsWith('압축 iTXt 설명'));
  assert.ok(find(r, 'Comment', 'zTXt').value.startsWith('zTXt comment'));
  assert.ok(r.summaries[0].prompt.includes('한국어 프롬프트'));
});

test('PNG NovelAI Comment JSON', async () => {
  const r = await parseImage(await fx('novelai.png'));
  assert.ok(r.hasAlpha);
  const s = r.summaries.find((x) => x.type === 'NovelAI');
  assert.ok(s);
  assert.equal(r.summaries.length, 1);
  assert.equal(s.prompt, '1girl, silver hair, caveduck');
  assert.equal(s.negative, 'lowres, worst quality');
  assert.equal(s.params.seed, 42);
  assert.equal(s.params.sampler, 'k_euler_ancestral');
  assert.equal(s.params.Source, 'NovelAI Diffusion V4.5 4BDE2A90');
  assert.equal(s.characters[0].prompt, 'girl, red eyes');
  assert.equal(s.characters[0].negative, 'blurry');
});

test('PNG ComfyUI prompt/workflow', async () => {
  const r = await parseImage(await fx('comfyui.png'));
  const s = r.summaries.find((x) => x.type === 'ComfyUI');
  assert.equal(s.prompt, 'a cat in a cave');
  assert.equal(s.negative, 'ugly, blurry');
  assert.equal(s.params.seed, 777);
  assert.equal(s.params.checkpoint, 'sdxl_base.safetensors');
  assert.equal(s.params.size, '1024x1024');
  assert.ok(find(r, 'workflow').json.nodes);
});

test('PNG XMP(iTXt) + eXIf', async () => {
  const r = await parseImage(await fx('png_xmp_exif.png'));
  assert.ok(find(r, 'XMP'));
  assert.equal(find(r, 'dc:description').value, 'xmp prompt & test');
  assert.equal(find(r, 'xmp:CreatorTool').value, 'TestTool 1.0');
  assert.equal(find(r, 'ImageDescription', 'eXIf').value, 'png exif description');
  assert.equal(find(r, 'Software', 'eXIf').value, 'ExifWriter');
});

test('JPEG EXIF UserComment(UNICODE BE) + XMP + COM', async () => {
  const r = await parseImage(await fx('a1111_exif.jpg'));
  assert.equal(r.format, 'JPEG');
  assert.equal(r.width, 8); assert.equal(r.height, 6);
  assert.ok(find(r, 'UserComment').value.includes('한국어 프롬프트'));
  assert.equal(find(r, 'ImageDescription').value, 'jpeg description');
  assert.equal(find(r, 'Software').value, 'SD WebUI');
  assert.equal(find(r, 'Comment', 'COM').value, 'jpeg COM 코멘트');
  assert.ok(find(r, 'XMP', 'JPEG XMP'));
  const s = r.summaries.find((x) => x.type === 'SD-WebUI');
  assert.equal(s.params.Seed, '1234567890');
});

test('JPEG UserComment UTF-16LE 자동 판별', async () => {
  const r = await parseImage(await fx('usercomment_le.jpg'));
  assert.equal(find(r, 'UserComment').value, 'little endian comment, Steps: 5, Sampler: Euler');
});

test('WebP EXIF + XMP', async () => {
  const r = await parseImage(await fx('a1111.webp'));
  assert.equal(r.format, 'WebP');
  assert.equal(r.width, 8); assert.equal(r.height, 6);
  assert.ok(find(r, 'UserComment', 'WebP').value.includes('Negative prompt'));
  assert.equal(find(r, 'Software', 'WebP').value, 'WebPWriter');
  assert.ok(find(r, 'XMP', 'WebP XMP'));
  assert.ok(r.hasGenerationInfo);
});

test('GIF 코멘트', async () => {
  const r = await parseImage(await fx('comment.gif'));
  assert.equal(r.format, 'GIF');
  assert.equal(find(r, 'Comment', 'GIF').value, 'gif comment text');
});

for (const f of ['plain.png', 'plain.jpg', 'plain.webp']) {
  test(`메타데이터 없음: ${f}`, async () => {
    const r = await parseImage(await fx(f));
    assert.equal(r.hasGenerationInfo, false);
    assert.equal(r.summaries.length, 0);
    assert.ok(r.width > 0 && r.height > 0);
  });
}

test('HTML 응답 감지', async () => {
  const r = await parseImage(new TextEncoder().encode('<!DOCTYPE html><html>error</html>'));
  assert.equal(r.format, 'HTML');
  assert.equal(r.hasGenerationInfo, false);
  assert.ok(r.notes.length);
});

test('잘린 파일도 예외 없이 처리', async () => {
  const buf = await fx('novelai.png');
  const r = await parseImage(buf.subarray(0, 120));
  assert.equal(r.format, 'PNG');
  assert.ok(r.notes.some((n) => n.includes('잘려')));
});

// stealth: JS 로 RGBA 픽셀에 직접 심어서 검증
function embed(text, w, h, { compressed, mode }) {
  let data = Buffer.from(text, 'utf8');
  if (compressed) data = gzipSync(data);
  const sig = { alphafalse: 'stealth_pnginfo', alphatrue: 'stealth_pngcomp', rgbfalse: 'stealth_rgbinfo', rgbtrue: 'stealth_rgbcomp' }[mode + compressed];
  const bytes = [...Buffer.from(sig), ...[24, 16, 8, 0].map((s) => ((data.length * 8) >>> s) & 255), ...data];
  const bits = bytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  const per = mode === 'alpha' ? 1 : 3;
  for (let i = 0; i < bits.length; i++) {
    const p = Math.floor(i / per), x = Math.floor(p / h), y = p % h;
    const o = (y * w + x) * 4 + (mode === 'alpha' ? 3 : i % per);
    px[o] = (px[o] & 0xfe) | bits[i];
  }
  return px;
}

test('stealth pnginfo: alpha + gzip, NovelAI JSON', async () => {
  const payload = JSON.stringify({ Software: 'NovelAI', Comment: JSON.stringify({ prompt: 'hidden prompt', uc: 'bad', seed: 9 }) });
  const st = await decodeStealth(embed(payload, 40, 50, { compressed: true, mode: 'alpha' }), 40, 50);
  assert.equal(st.mode, 'alpha');
  const r = mergeStealth({ entries: [] }, st);
  const s = r.summaries.find((x) => x.type === 'NovelAI');
  assert.equal(s.prompt, 'hidden prompt');
  assert.equal(s.params.seed, 9);
});

test('stealth pnginfo: rgb 비압축 A1111', async () => {
  const st = await decodeStealth(embed('cat\nNegative prompt: dog\nSteps: 3, Seed: 1', 30, 30, { compressed: false, mode: 'rgb' }), 30, 30);
  assert.equal(st.mode, 'rgb');
  const r = mergeStealth({ entries: [] }, st);
  assert.equal(r.summaries[0].negative, 'dog');
});

test('stealth 없음 → null', async () => {
  assert.equal(await decodeStealth(new Uint8ClampedArray(20 * 20 * 4).fill(255), 20, 20), null);
});

test('parseA1111: 프롬프트만 있는 경우', () => {
  const a = parseA1111('just a prompt');
  assert.equal(a.prompt, 'just a prompt');
  assert.equal(a.negative, '');
});

test('decodeUserComment: ASCII 헤더', () => {
  const b = new Uint8Array([...Buffer.from('ASCII\0\0\0hello')]);
  assert.equal(decodeUserComment(b), 'hello');
});
