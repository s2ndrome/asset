import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, crc32 } from '../js/zip.js';

test('crc32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP: 바이트 그대로 + 한글 이름 + 중복 이름', () => {
  const png = readFileSync(new URL('./fixtures/novelai.png', import.meta.url));
  const zip = makeZip([{ name: '티스토리_img.png', data: png }, { name: '티스토리_img.png', data: new Uint8Array([1, 2, 3]) }]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const p = join(dir, 'a.zip');
  writeFileSync(p, zip);
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, hashlib
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for i in z.infolist(): print(i.filename, i.file_size, hashlib.md5(z.read(i)).hexdigest())`, p]).toString().trim().split('\n');
  assert.equal(out.length, 2);
  assert.ok(out[0].startsWith(`티스토리_img.png ${png.length} `));
  assert.ok(out[1].startsWith('티스토리_img_2.png 3 '));
  const md5 = execFileSync('python3', ['-c', 'import hashlib,sys;print(hashlib.md5(open(sys.argv[1],"rb").read()).hexdigest())', new URL('./fixtures/novelai.png', import.meta.url).pathname]).toString().trim();
  assert.ok(out[0].endsWith(md5));
});
