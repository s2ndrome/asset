// 이미지 파일 바이트에서 AI 생성 메타데이터를 읽는 순수 JS 파서.
// 외부 라이브러리 없음. 브라우저와 Node 18+ (DecompressionStream, TextDecoder) 에서 동작.

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

function decodeText(bytes, preferUtf8 = true) {
  if (preferUtf8) {
    try { return utf8.decode(bytes); } catch { /* 아래로 */ }
  }
  return latin1.decode(bytes);
}

function ascii(bytes, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < bytes.length; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

function startsWith(bytes, off, str) {
  if (off + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) if (bytes[off + i] !== str.charCodeAt(i)) return false;
  return true;
}

function indexOfByte(bytes, b, from, to = bytes.length) {
  for (let i = from; i < to; i++) if (bytes[i] === b) return i;
  return -1;
}

async function decompress(bytes, format = 'deflate') {
  if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 DecompressionStream을 지원하지 않습니다');
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tryJson(s) {
  const t = typeof s === 'string' ? s.trim() : '';
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// ───────────────────────── 형식 판별 ─────────────────────────

export function detectFormat(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && startsWith(b, 1, 'PNG\r\n\x1a\n')) return { format: 'PNG', mime: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: 'JPEG', mime: 'image/jpeg' };
  if (b.length >= 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return { format: 'WebP', mime: 'image/webp' };
  if (b.length >= 6 && (startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a'))) return { format: 'GIF', mime: 'image/gif' };
  if (b.length >= 12 && startsWith(b, 4, 'ftyp')) {
    const brand = ascii(b, 8, 4);
    if (/avi[fs]/.test(brand)) return { format: 'AVIF', mime: 'image/avif' };
    if (/hei[cx]|mif1|msf1|heim|heis/.test(brand)) return { format: 'HEIF', mime: 'image/heif' };
    return { format: `ISOBMFF(${brand.trim()})`, mime: 'application/octet-stream' };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { format: 'BMP', mime: 'image/bmp' };
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42)))
    return { format: 'TIFF', mime: 'image/tiff' };
  const head = latin1.decode(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return { format: 'HTML', mime: 'text/html' };
  if (head.startsWith('{') || head.startsWith('[')) return { format: 'JSON', mime: 'application/json' };
  return { format: '알 수 없음', mime: 'application/octet-stream' };
}

// ───────────────────────── EXIF ─────────────────────────

const EXIF_TAGS = {
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright',
  0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject',
  0x9286: 'UserComment', 0x9003: 'DateTimeOriginal', 0xa430: 'CameraOwnerName',
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** UserComment(8바이트 문자코드 헤더 + 데이터) 디코딩 */
export function decodeUserComment(bytes, littleEndianTiff = false) {
  if (bytes.length < 8) return decodeText(bytes).replace(/\0+$/, '');
  const code = ascii(bytes, 0, 8);
  const data = bytes.subarray(8);
  if (code.startsWith('UNICODE')) {
    // UTF-16. 엔디언은 도구마다 다르므로 0 바이트 위치로 추정한다.
    let evenZero = 0, oddZero = 0;
    const n = Math.min(data.length, 400);
    for (let i = 0; i + 1 < n; i += 2) { if (data[i] === 0) evenZero++; if (data[i + 1] === 0) oddZero++; }
    let le = littleEndianTiff;
    if (evenZero !== oddZero) le = oddZero > evenZero;
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(data).replace(/\0+$/, '');
  }
  if (code.startsWith('ASCII') || code === '\0\0\0\0\0\0\0\0') return decodeText(data).replace(/\0+$/, '');
  if (code.startsWith('JIS')) {
    try { return new TextDecoder('shift_jis').decode(data).replace(/\0+$/, ''); } catch { /* fallthrough */ }
  }
  // 헤더 없이 바로 텍스트가 들어간 비표준 파일
  return decodeText(bytes).replace(/\0+$/, '');
}

/** TIFF 구조의 EXIF 블록 파싱. bytes 는 "II*\0" / "MM\0*" 로 시작해야 한다. */
export function parseExif(bytes) {
  const out = [];
  if (startsWith(bytes, 0, 'Exif\0\0')) bytes = bytes.subarray(6);
  if (bytes.length < 8) return out;
  const le = bytes[0] === 0x49;
  if (!(le || bytes[0] === 0x4d)) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const visited = new Set();

  const readIfd = (off, ifdName) => {
    if (!off || off + 2 > bytes.length || visited.has(off)) return;
    visited.add(off);
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) { // ExifIFD / GPS / Interop
        if (tag === 0x8769) readIfd(u32(e + 8), 'Exif');
        continue;
      }
      const name = EXIF_TAGS[tag];
      if (!name) continue;
      const size = (TYPE_SIZE[type] || 1) * count;
      const vOff = size <= 4 ? e + 8 : u32(e + 8);
      if (vOff + size > bytes.length) continue;
      const raw = bytes.subarray(vOff, vOff + size);
      let value;
      if (tag === 0x9286) value = decodeUserComment(raw, le);
      else if (name.startsWith('XP')) value = new TextDecoder('utf-16le').decode(raw).replace(/\0+$/, '');
      else value = decodeText(raw).replace(/\0+$/, '');
      if (value.trim()) out.push({ source: `EXIF ${ifdName}`, key: name, value });
    }
    if (ifdName === 'IFD0') {
      const next = off + 2 + n * 12;
      if (next + 4 <= bytes.length) readIfd(u32(next), 'IFD1');
    }
  };
  readIfd(u32(4), 'IFD0');
  return out;
}

// ───────────────────────── XMP ─────────────────────────

const XMP_FIELDS = ['dc:description', 'dc:title', 'dc:subject', 'exif:UserComment', 'xmp:CreatorTool', 'tiff:ImageDescription',
  'photoshop:Instructions', 'Iptc4xmpExt:AOSource', 'parameters'];

/** XMP 문자열에서 사람이 읽을 만한 필드를 뽑는다. */
export function extractXmpFields(xmp) {
  const out = [];
  const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
  for (const f of XMP_FIELDS) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 속성 형식: dc:description="..."
    const attr = xmp.match(new RegExp(`\\s${esc}="([^"]*)"`));
    if (attr && attr[1].trim()) { out.push({ key: f, value: decodeXml(attr[1]) }); continue; }
    // 요소 형식: <dc:description><rdf:Alt><rdf:li ...>...</rdf:li></rdf:Alt></dc:description>
    const el = xmp.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`));
    if (el) {
      const lis = [...el[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => m[1]);
      const v = decodeXml((lis.length ? lis.join(', ') : el[1]).replace(/<[^>]+>/g, '').trim());
      if (v) out.push({ key: f, value: v });
    }
  }
  return out;
}

function pushXmp(entries, xmp, source) {
  entries.push({ source, key: 'XMP', value: xmp });
  for (const f of extractXmpFields(xmp)) entries.push({ source: `${source} 필드`, key: f.key, value: f.value });
}

// ───────────────────────── PNG ─────────────────────────

async function parsePng(bytes, res) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = ascii(bytes, off + 4, 4);
    const dStart = off + 8;
    const dEnd = dStart + len;
    if (dEnd + 4 > bytes.length) { res.notes.push(`PNG ${type} 청크가 잘려 있습니다(파일 손상 또는 일부만 받음)`); break; }
    const d = bytes.subarray(dStart, dEnd);
    try {
      if (type === 'IHDR') {
        res.width = dv.getUint32(dStart); res.height = dv.getUint32(dStart + 4);
        res.bitDepth = d[8]; res.colorType = d[9];
        res.hasAlpha = d[9] === 4 || d[9] === 6;
      } else if (type === 'acTL') {
        res.animated = true;
      } else if (type === 'tRNS') {
        res.hasAlpha = true;
      } else if (type === 'tEXt') {
        const z = indexOfByte(d, 0, 0);
        const key = latin1.decode(d.subarray(0, z));
        res.entries.push({ source: 'PNG tEXt', key, value: decodeText(d.subarray(z + 1)) });
      } else if (type === 'zTXt') {
        const z = indexOfByte(d, 0, 0);
        const key = latin1.decode(d.subarray(0, z));
        const text = await decompress(d.subarray(z + 2));
        res.entries.push({ source: 'PNG zTXt', key, value: decodeText(text) });
      } else if (type === 'iTXt') {
        const z1 = indexOfByte(d, 0, 0);
        const key = latin1.decode(d.subarray(0, z1));
        const compressed = d[z1 + 1] === 1;
        const z2 = indexOfByte(d, 0, z1 + 3);
        const lang = latin1.decode(d.subarray(z1 + 3, z2));
        const z3 = indexOfByte(d, 0, z2 + 1);
        const tkey = utf8Loose.decode(d.subarray(z2 + 1, z3));
        let text = d.subarray(z3 + 1);
        if (compressed) text = await decompress(text);
        const value = utf8Loose.decode(text);
        const src = `PNG iTXt${compressed ? '(압축)' : ''}`;
        if (key === 'XML:com.adobe.xmp') pushXmp(res.entries, value, src);
        else res.entries.push({ source: src, key, value, ...(lang || tkey ? { lang, translatedKey: tkey } : {}) });
      } else if (type === 'eXIf') {
        res.entries.push(...parseExif(d).map((e) => ({ ...e, source: `PNG eXIf/${e.source}` })));
      } else if (type === 'IEND') {
        break;
      }
    } catch (err) {
      res.notes.push(`PNG ${type} 청크 해석 실패: ${err.message}`);
    }
    off = dEnd + 4;
  }
}

// ───────────────────────── JPEG ─────────────────────────

function parseJpeg(bytes, res) {
  let off = 2;
  const extXmp = [];
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) { off++; continue; }
    const marker = bytes[off + 1];
    if (marker === 0xff) { off++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS: 이후는 이미지 데이터
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    const d = bytes.subarray(off + 4, Math.min(bytes.length, off + 2 + len));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      res.height = (d[1] << 8) | d[2];
      res.width = (d[3] << 8) | d[4];
      res.progressive = marker === 0xc2;
    } else if (marker === 0xe1) {
      if (startsWith(d, 0, 'Exif\0')) {
        res.entries.push(...parseExif(d.subarray(6)));
      } else if (startsWith(d, 0, 'http://ns.adobe.com/xap/1.0/\0')) {
        pushXmp(res.entries, utf8Loose.decode(d.subarray(29)), 'JPEG XMP');
      } else if (startsWith(d, 0, 'http://ns.adobe.com/xmp/extension/\0')) {
        extXmp.push(d.subarray(35 + 32 + 8));
      }
    } else if (marker === 0xfe) {
      res.entries.push({ source: 'JPEG COM', key: 'Comment', value: decodeText(d) });
    } else if (marker === 0xe0 && startsWith(d, 0, 'JFIF')) {
      res.jfif = true;
    }
    off += 2 + len;
  }
  if (extXmp.length) {
    const total = extXmp.reduce((a, c) => a + c.length, 0);
    const all = new Uint8Array(total);
    let p = 0;
    for (const c of extXmp) { all.set(c, p); p += c.length; }
    pushXmp(res.entries, utf8Loose.decode(all), 'JPEG 확장 XMP');
  }
}

// ───────────────────────── WebP ─────────────────────────

function parseWebp(bytes, res) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = ascii(bytes, off, 4);
    const len = dv.getUint32(off + 4, true);
    const d = bytes.subarray(off + 8, Math.min(bytes.length, off + 8 + len));
    if (type === 'VP8X') {
      res.width = 1 + (d[4] | (d[5] << 8) | (d[6] << 16));
      res.height = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
      res.hasAlpha = !!(d[0] & 0x10);
      res.animated = !!(d[0] & 0x02);
    } else if (type === 'VP8 ' && res.width == null && d.length >= 10) {
      res.width = (d[6] | (d[7] << 8)) & 0x3fff;
      res.height = (d[8] | (d[9] << 8)) & 0x3fff;
      res.webpCodec = '손실(VP8)';
    } else if (type === 'VP8L' && d.length >= 5) {
      if (res.width == null) {
        const bits = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
        res.width = (bits & 0x3fff) + 1;
        res.height = ((bits >>> 14) & 0x3fff) + 1;
        res.hasAlpha = !!((bits >>> 28) & 1);
      }
      res.webpCodec = '무손실(VP8L)';
    } else if (type === 'VP8 ') {
      res.webpCodec = '손실(VP8)';
    } else if (type === 'EXIF') {
      res.entries.push(...parseExif(d).map((e) => ({ ...e, source: `WebP ${e.source}` })));
    } else if (type === 'XMP ') {
      pushXmp(res.entries, utf8Loose.decode(d), 'WebP XMP');
    } else if (type === 'ANIM') {
      res.animated = true;
    }
    off += 8 + len + (len & 1);
  }
}

// ───────────────────────── GIF ─────────────────────────

function parseGif(bytes, res) {
  res.width = bytes[6] | (bytes[7] << 8);
  res.height = bytes[8] | (bytes[9] << 8);
  let off = 13;
  if (bytes[10] & 0x80) off += 3 * (1 << ((bytes[10] & 7) + 1));
  let frames = 0;
  const readSub = (o) => {
    const parts = [];
    while (o < bytes.length) {
      const n = bytes[o++];
      if (n === 0) break;
      parts.push(bytes.subarray(o, o + n));
      o += n;
    }
    return { o, parts };
  };
  while (off < bytes.length) {
    const b = bytes[off++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[off++];
      if (label === 0xfe) {
        const { o, parts } = readSub(off);
        const all = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
        let p = 0; for (const c of parts) { all.set(c, p); p += c.length; }
        res.entries.push({ source: 'GIF Comment', key: 'Comment', value: decodeText(all) });
        off = o;
      } else if (label === 0xff && startsWith(bytes, off + 1, 'XMP DataXMP')) {
        // XMP 는 서브블록 규칙을 무시하는 특수 형식 → 원문 그대로 검색
        const start = off + 12;
        const tail = latin1.decode(bytes.subarray(start, Math.min(bytes.length, start + (1 << 20))));
        const end = tail.indexOf('<?xpacket end');
        const xmpBytes = bytes.subarray(start, start + (end >= 0 ? tail.indexOf('>', end) + 1 : 0));
        if (xmpBytes.length) pushXmp(res.entries, utf8Loose.decode(xmpBytes), 'GIF XMP');
        off = readSub(off).o;
      } else {
        off = readSub(off).o;
      }
    } else if (b === 0x2c) {
      frames++;
      const packed = bytes[off + 8];
      off += 9;
      if (packed & 0x80) off += 3 * (1 << ((packed & 7) + 1));
      off++; // LZW 최소 코드 크기
      off = readSub(off).o;
    } else {
      break;
    }
  }
  res.frames = frames;
  res.animated = frames > 1;
}

// ───────────────────────── AVIF/HEIF (해상도만) ─────────────────────────

function parseIsoBmff(bytes, res) {
  // ispe 박스: [size][ 'ispe' ][version/flags 4][width 4][height 4]
  for (let i = 4; i + 16 <= bytes.length && i < 1 << 16; i++) {
    if (startsWith(bytes, i, 'ispe')) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      res.width = dv.getUint32(i + 8); res.height = dv.getUint32(i + 12);
      break;
    }
  }
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const ei = head.indexOf('Exif\0\0');
  if (ei >= 0) res.entries.push(...parseExif(bytes.subarray(ei + 6)).map((e) => ({ ...e, source: `${res.format} ${e.source}` })));
}

// ───────────────────────── 생성 정보 해석 ─────────────────────────

/** Stable Diffusion WebUI(A1111/Forge) "parameters" 텍스트 해석 */
export function parseA1111(text) {
  const lines = String(text).trim().split('\n');
  let settingsLine = '';
  if (lines.length && /(^|,\s*)Steps:\s*\d+/.test(lines[lines.length - 1])) settingsLine = lines.pop();
  let prompt = [], negative = [], inNeg = false;
  for (const l of lines) {
    if (l.startsWith('Negative prompt:')) { inNeg = true; negative.push(l.slice(16).trimStart()); continue; }
    (inNeg ? negative : prompt).push(l);
  }
  const params = {};
  const re = /\s*([\w ]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g;
  for (const m of settingsLine.matchAll(re)) {
    if (!m[1]) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* 그대로 */ } }
    params[m[1].trim()] = v;
  }
  return { prompt: prompt.join('\n').trim(), negative: negative.join('\n').trim(), params };
}

export function looksLikeA1111(text) {
  return typeof text === 'string' && /(^|\n)(Negative prompt:|Steps:\s*\d+,)|,\s*Sampler:\s|,\s*CFG scale:\s/.test(text);
}

const NAI_PARAM_KEYS = ['steps', 'scale', 'cfg_rescale', 'seed', 'sampler', 'noise_schedule', 'width', 'height',
  'strength', 'noise', 'sm', 'sm_dyn', 'n_samples', 'uncond_scale', 'dynamic_thresholding', 'skip_cfg_above_sigma',
  'legacy', 'legacy_v3_extend', 'request_type', 'prefer_brownian', 'controlnet_strength', 'reference_strength_multiple',
  'version'];

/** NovelAI Comment JSON 해석 */
export function summarizeNovelAI(comment, extras = {}) {
  const c = typeof comment === 'string' ? tryJson(comment) || {} : comment || {};
  const params = {};
  for (const k of NAI_PARAM_KEYS) if (c[k] !== undefined && c[k] !== null) params[k] = typeof c[k] === 'object' ? JSON.stringify(c[k]) : c[k];
  const characters = [];
  const chars = c.v4_prompt?.caption?.char_captions || [];
  const negChars = c.v4_negative_prompt?.caption?.char_captions || [];
  chars.forEach((ch, i) => characters.push({
    prompt: ch.char_caption || '',
    negative: negChars[i]?.char_caption || '',
    centers: ch.centers ? ch.centers.map((p) => `(${p.x}, ${p.y})`).join(' ') : '',
  }));
  return {
    type: 'NovelAI',
    title: 'NovelAI',
    prompt: c.v4_prompt?.caption?.base_caption ?? c.prompt ?? extras.Description ?? '',
    negative: c.v4_negative_prompt?.caption?.base_caption ?? c.uc ?? '',
    params: { ...params, ...(extras.Software ? { Software: extras.Software } : {}), ...(extras.Source ? { Source: extras.Source } : {}) },
    characters,
  };
}

/** ComfyUI prompt(API 형식) JSON에서 프롬프트·샘플러 설정 추출 */
export function summarizeComfy(promptJson) {
  const g = typeof promptJson === 'string' ? tryJson(promptJson) : promptJson;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const nodes = g;
  const textOf = (ref, depth = 0) => {
    if (typeof ref === 'string') return ref;
    if (!Array.isArray(ref) || depth > 6) return '';
    const n = nodes[ref[0]];
    if (!n || !n.inputs) return '';
    const inp = n.inputs;
    for (const k of ['text', 'text_g', 'prompt', 'positive', 'string', 'value', 'conditioning', 'conditioning_1', 'conditioning_to']) {
      if (inp[k] === undefined) continue;
      const t = textOf(inp[k], depth + 1);
      if (t) return t + (k === 'text_g' && typeof inp.text_l === 'string' && inp.text_l !== inp.text_g ? `\n[text_l] ${inp.text_l}` : '');
    }
    return '';
  };
  const params = {};
  let prompt = '', negative = '';
  const samplers = Object.entries(nodes).filter(([, n]) => /KSampler|Sampler/i.test(n?.class_type || '') && n.inputs);
  for (const [id, n] of samplers) {
    const i = n.inputs;
    if (!prompt && i.positive) prompt = textOf(i.positive);
    if (!negative && i.negative) negative = textOf(i.negative);
    for (const k of ['seed', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
      if (i[k] !== undefined && typeof i[k] !== 'object' && params[k] === undefined) params[k] = i[k];
    }
    params.sampler_node = params.sampler_node || `${n.class_type} #${id}`;
  }
  const loras = [];
  for (const n of Object.values(nodes)) {
    const i = n?.inputs || {};
    if (typeof i.ckpt_name === 'string' && !params.checkpoint) params.checkpoint = i.ckpt_name;
    if (typeof i.unet_name === 'string' && !params.unet) params.unet = i.unet_name;
    if (typeof i.lora_name === 'string') loras.push(`${i.lora_name} (${i.strength_model ?? ''}${i.strength_clip !== undefined ? '/' + i.strength_clip : ''})`);
    if (/EmptyLatentImage/.test(n?.class_type || '') && typeof i.width === 'number') params.size = `${i.width}x${i.height}`;
  }
  if (loras.length) params.loras = loras.join(', ');
  // 샘플러 추적이 안 되면 텍스트 인코더 텍스트라도 모은다
  const texts = [];
  if (!prompt) {
    for (const n of Object.values(nodes)) {
      if (/TextEncode|Prompt/i.test(n?.class_type || '') && typeof n.inputs?.text === 'string') texts.push(n.inputs.text);
    }
    prompt = texts.join('\n---\n');
  }
  return { type: 'ComfyUI', title: 'ComfyUI', prompt, negative, params, characters: [] };
}

const GEN_KEYS = new Set(['parameters', 'prompt', 'workflow', 'Comment', 'Description', 'UserComment', 'invokeai_metadata',
  'invokeai_graph', 'sd-metadata', 'Dream', 'generation_data', 'XPComment', 'ImageDescription', 'Comment', 'comfy',
  'smproj', 'fooocus_scheme', 'lora_hashes', 'negative_prompt', 'exif:UserComment', 'dc:description', 'tiff:ImageDescription']);

/** 원시 항목 목록으로부터 생성기별 요약을 만든다 */
export function interpret(entries) {
  const summaries = [];
  const byKey = {};
  for (const e of entries) if (!(e.key in byKey)) byKey[e.key] = e.value;

  for (const e of entries) {
    const j = tryJson(e.value);
    if (j !== undefined) e.json = j;
  }

  // NovelAI
  const isNai = /NovelAI/i.test(byKey.Software || '') || /NovelAI/i.test(byKey.Title || '') ||
    (byKey.Comment && /"(uc|v4_prompt|n_samples|noise_schedule)"/.test(byKey.Comment));
  if (isNai) {
    summaries.push(summarizeNovelAI(byKey.Comment || '{}', byKey));
  }
  // A1111 계열: parameters, 또는 EXIF UserComment 등에 같은 형식
  for (const e of entries) {
    if (e.key === 'parameters' || ((e.key === 'UserComment' || e.key === 'Comment' || e.key === 'Description' || e.key === 'ImageDescription' || e.key === 'exif:UserComment') && looksLikeA1111(e.value))) {
      if (isNai && e.key !== 'parameters') continue;
      const a = parseA1111(e.value);
      summaries.push({ type: 'SD-WebUI', title: `Stable Diffusion WebUI 계열 (${e.source} · ${e.key})`, ...a, characters: [] });
    }
  }
  // ComfyUI
  const comfyPrompt = entries.find((e) => e.key === 'prompt' && e.json && !Array.isArray(e.json) && Object.values(e.json).some((n) => n && n.class_type));
  if (comfyPrompt) {
    const s = summarizeComfy(comfyPrompt.json);
    if (s) summaries.push(s);
  } else if (entries.some((e) => e.key === 'workflow' && e.json?.nodes)) {
    summaries.push({ type: 'ComfyUI', title: 'ComfyUI (workflow만 있음)', prompt: '', negative: '', params: {}, characters: [] });
  }
  // EXIF UserComment 안에 ComfyUI/NovelAI JSON 이 들어간 경우
  for (const e of entries) {
    if (e.source.startsWith('PNG') || e === comfyPrompt || e.key === 'workflow' || (isNai && e.key === 'Comment')) continue;
    if (e.json && typeof e.json === 'object' && !Array.isArray(e.json)) {
      if (Object.values(e.json).some((n) => n && n.class_type)) summaries.push(summarizeComfy(e.json));
      else if ('uc' in e.json || 'v4_prompt' in e.json) summaries.push(summarizeNovelAI(e.json));
    }
  }
  const hasGen = summaries.length > 0 || entries.some((e) => GEN_KEYS.has(e.key) && String(e.value).trim().length > 0 &&
    !(e.key === 'ImageDescription' && String(e.value).length < 4));
  return { summaries, hasGenerationInfo: hasGen };
}

// ───────────────────────── Stealth PNG info ─────────────────────────

const STEALTH_SIGS = {
  stealth_pnginfo: { mode: 'alpha', compressed: false },
  stealth_pngcomp: { mode: 'alpha', compressed: true },
  stealth_rgbinfo: { mode: 'rgb', compressed: false },
  stealth_rgbcomp: { mode: 'rgb', compressed: true },
};

/**
 * NovelAI / sd-webui-stealth-pnginfo 방식으로 픽셀 최하위 비트에 숨겨진 정보 읽기.
 * rgba: Uint8(Clamped)Array (width*height*4), 열 우선(x 바깥, y 안쪽) 순서로 비트를 읽는다.
 * @returns {Promise<null | {mode, compressed, text}>}
 */
export async function decodeStealth(rgba, width, height) {
  const total = width * height;
  for (const mode of ['alpha', 'rgb']) {
    const perPx = mode === 'alpha' ? 1 : 3;
    let idx = 0; // 픽셀 내 비트 위치 포함 전체 비트 인덱스
    const bitAt = (n) => {
      const p = Math.floor(n / perPx);
      if (p >= total) return -1;
      const x = Math.floor(p / height), y = p % height;
      const base = (y * width + x) * 4;
      return mode === 'alpha' ? rgba[base + 3] & 1 : rgba[base + (n % perPx)] & 1;
    };
    const readBytes = (count) => {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        let v = 0;
        for (let b = 0; b < 8; b++) { const bit = bitAt(idx++); if (bit < 0) return null; v = (v << 1) | bit; }
        out[i] = v;
      }
      return out;
    };
    const sigBytes = readBytes(15);
    if (!sigBytes) continue;
    const sig = latin1.decode(sigBytes);
    const info = STEALTH_SIGS[sig];
    if (!info || info.mode !== mode) continue;
    const lenBytes = readBytes(4);
    if (!lenBytes) return null;
    const bitLen = ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0;
    if (bitLen === 0 || bitLen > total * perPx) return null;
    const data = readBytes(Math.floor(bitLen / 8));
    if (!data) return null;
    const raw = info.compressed ? await decompress(data, 'gzip') : data;
    return { mode, compressed: info.compressed, text: utf8Loose.decode(raw) };
  }
  return null;
}

/** stealth 결과를 entries 형태로 변환 */
export function stealthToEntries(st) {
  const source = `Stealth(${st.mode}${st.compressed ? ', gzip' : ''})`;
  const j = tryJson(st.text);
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    return Object.entries(j).map(([key, v]) => ({ source, key, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  }
  return [{ source, key: 'parameters', value: st.text }];
}

// ───────────────────────── 진입점 ─────────────────────────

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{format, mime, size, width?, height?, entries, summaries, hasGenerationInfo, notes}>}
 */
export async function parseImage(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { format, mime } = detectFormat(bytes);
  const res = { format, mime, size: bytes.length, width: null, height: null, entries: [], notes: [] };
  try {
    if (format === 'PNG') await parsePng(bytes, res);
    else if (format === 'JPEG') parseJpeg(bytes, res);
    else if (format === 'WebP') parseWebp(bytes, res);
    else if (format === 'GIF') parseGif(bytes, res);
    else if (format === 'AVIF' || format === 'HEIF') parseIsoBmff(bytes, res);
    else if (format === 'HTML' || format === 'JSON') res.notes.push('이미지가 아니라 텍스트(HTML/JSON) 응답입니다. 주소가 잘못됐거나 오류 페이지일 수 있습니다.');
  } catch (err) {
    res.notes.push(`파싱 중 오류: ${err.message}`);
  }
  // 구조적으로 못 찾은 XMP 를 원문 검색으로 보완
  if (!res.entries.some((e) => e.key === 'XMP') && format !== 'HTML') {
    const s = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 4 << 20)));
    const a = s.indexOf('<x:xmpmeta');
    if (a >= 0) {
      const b = s.indexOf('</x:xmpmeta>', a);
      if (b > a) pushXmp(res.entries, utf8Loose.decode(bytes.subarray(a, b + 12)), `${format} XMP(원문 검색)`);
    }
  }
  const { summaries, hasGenerationInfo } = interpret(res.entries);
  res.summaries = summaries;
  res.hasGenerationInfo = hasGenerationInfo;
  return res;
}

/** stealth 결과를 기존 파싱 결과에 병합 */
export function mergeStealth(res, st) {
  if (!st) return res;
  res.entries.push(...stealthToEntries(st));
  const { summaries, hasGenerationInfo } = interpret(res.entries);
  res.summaries = summaries;
  res.hasGenerationInfo = hasGenerationInfo;
  return res;
}
