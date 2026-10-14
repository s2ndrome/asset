#!/usr/bin/env python3
"""이미지 주소(caveduck·티스토리·노션·일반)의 원본을 찾아 AI 생성 메타데이터(프롬프트 등)를 출력한다.

사용법:
    python caveduck_meta.py <caveduck 이미지 URL | 이미지 파일 | 페이지 HTML 파일> [...]
    python caveduck_meta.py -            # 표준입력(주소 여러 줄 또는 HTML 소스)

옵션은 --help 참고. 표준 라이브러리만으로 동작하며, Pillow 가 있으면 픽셀에 숨긴
stealth pnginfo 도 검사한다.
"""
from __future__ import annotations

import argparse
import gzip
import html as htmlmod
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

try:
    from PIL import Image  # 선택
except Exception:  # pragma: no cover
    Image = None

CDN_HOST = "cdn.caveduck.io"
KINDS = ["charim", "charim-1920x", "charim-standard", "charim-160x160"]
KIND_LABEL = {
    "charim": "업로드 원본(추정)",
    "charim-1920x": "1920px 리사이즈",
    "charim-standard": "640px WebP (표준)",
    "charim-160x160": "160×160 썸네일",
}
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
UA = "Mozilla/5.0 (caveduck-meta CLI)"


# ───────────────────────── URL ─────────────────────────

def clean_input(s: str) -> str:
    t = (s or "").strip()
    t = t.replace("&amp;", "&").replace("\\/", "/")
    t = re.sub(r"\\u002[fF]", "/", t)
    t = re.sub(r"^[\s|'\"`<(\[{]+", "", t)
    t = re.sub(r"[\s|'\"`>)\]},;\\]+$", "", t)
    m = re.search(r"https?://[^\s|'\"`<>()\[\]{}\\]+", t)
    if m:
        t = m.group(0)
    return re.sub(r"[.,;]+$", "", t)


def parse_caveduck_url(raw: str):
    """URL 또는 'charim-standard/<uuid>' 경로 → {uuid, kind, v, candidates[...]} 또는 None"""
    inp = clean_input(raw)
    if not inp:
        return None
    if re.match(r"^https?://", inp, re.I):
        u = urllib.parse.urlsplit(inp)
        host = (u.hostname or "").lower()
        if host != CDN_HOST and not host.endswith(".caveduck.io"):
            return None
        path, query = u.path, u.query
    else:
        path, _, query = inp.partition("?")
    path = path.lstrip("/")
    path = re.sub(r"^cdn-cgi/image/[^/]*/", "", path)
    path = re.sub(r"^https?:/+[^/]+/", "", path)
    v = urllib.parse.parse_qs(query).get("v", [""])[0]
    m = re.match(r"^(charim(?:-[a-z0-9x]+)*)/([0-9a-f-]{36})", path, re.I)
    if not m:
        um = UUID_RE.search(path)
        if not um:
            if not re.match(r"^https?://", inp, re.I):
                return None
            url = f"https://{CDN_HOST}/{path}" + (f"?{query}" if query else "")
            return {"input": inp, "uuid": None, "kind": None, "v": v,
                    "candidates": [{"url": url, "kind": None, "label": "리사이즈 제거 주소", "note": ""}]}
        kind, uuid = None, um.group(0).lower()
    else:
        kind, uuid = m.group(1).lower(), m.group(2).lower()
    if not UUID_RE.fullmatch(uuid):
        return None

    def mk(k, vv="", note=""):
        q = f"?v={urllib.parse.quote(vv)}" if vv else ""
        return {"url": f"https://{CDN_HOST}/{k}/{uuid}{q}", "kind": k, "label": KIND_LABEL.get(k, k), "note": note}

    v_from_derived = bool(v) and (kind is None or kind in ("charim-standard", "charim-160x160") or kind not in KINDS)
    lst = []
    if v and not v_from_derived:
        lst += [mk("charim", v, "원래 v 값 유지"), mk("charim", "", "v 없음")]
    else:
        lst.append(mk("charim", "", "v 없음"))
        if v:
            lst.append(mk("charim", v, "원래 v 값"))
    lst.append(mk("charim-1920x"))
    if v:
        lst.append(mk("charim-1920x", v))
    lst.append(mk("charim-standard"))
    if v and kind == "charim-standard":
        lst.append(mk("charim-standard", v, "입력 주소(리사이즈 제거)"))
    lst.append(mk("charim-160x160"))
    if v and kind == "charim-160x160":
        lst.append(mk("charim-160x160", v, "입력 주소(리사이즈 제거)"))
    if kind and kind not in KINDS:
        lst.append(mk(kind, v, "입력 주소(리사이즈 제거)"))
    seen, cands = set(), []
    for c in lst:
        if c["url"] not in seen:
            seen.add(c["url"])
            cands.append(c)
    return {"input": inp, "uuid": uuid, "kind": kind, "v": v, "candidates": cands}


def _decode(s: str) -> str:
    for _ in range(3):
        if not re.search(r"%[0-9a-fA-F]{2}", s):
            break
        s = urllib.parse.unquote(s)
    return s


def parse_generic_url(raw: str):
    """티스토리·노션·일반 이미지 주소 → 원본 후보 (caveduck 이 아닌 경우)"""
    inp = clean_input(raw)
    if not re.match(r"^https?://", inp, re.I):
        return None
    u = urllib.parse.urlsplit(inp)
    host = (u.hostname or "").lower()
    qs = urllib.parse.parse_qs(u.query)
    cands = []

    def add(url, label, derived=False):
        if url and url not in [c["url"] for c in cands]:
            cands.append({"url": url, "kind": None, "label": label, "note": "", "derived": derived})

    if re.search(r"(^|\.)(daumcdn\.net|kakaocdn\.net|tistory\.com)$", host):
        site = "티스토리"
        if qs.get("fname"):
            add(re.sub(r"^http://", "https://", _decode(qs["fname"][0]), flags=re.I), "원본(fname 에서 추출)")
            add(inp, "입력 주소(썸네일)", True)
        elif re.match(r"^/cfile/tistory/", u.path, re.I):
            add(f"{u.scheme}://{u.netloc}{u.path}?original", "원본(?original)")
            add(inp, "입력 주소", True)
        else:
            add(inp, "입력 주소")
    elif re.search(r"(^|\.)notion\.so$|\.notion\.site$", host):
        site = "노션"
        m = re.match(r"^/image/(.+)$", u.path)
        if m:
            inner = _decode(m.group(1))
            if re.match(r"^https?://", inner):
                add(inner, "원본(S3, 서명 필요할 수 있음)")
            q = urllib.parse.urlencode([(k, v) for k, vs in qs.items() for v in vs if k not in ("width", "cache")])
            add(urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, q, "")), "노션 원본 크기")
            add(inp, "입력 주소", True)
        else:
            add(inp, "입력 주소")
    else:
        site = host[4:] if host.startswith("www.") else host
        m = re.match(r"^/cdn-cgi/image/[^/]*/(.+)$", u.path)
        if m:
            rest = m.group(1)
            add(rest if re.match(r"^https?://", rest) else f"{u.scheme}://{u.netloc}/{rest}" + (f"?{u.query}" if u.query else ""), "리사이즈 제거")
            add(inp, "입력 주소(리사이즈)", True)
        else:
            add(inp, "입력 주소")
    name = urllib.parse.unquote(cands[0]["url"].split("?")[0].rstrip("/").rsplit("/", 1)[-1]) or host
    return {"input": inp, "uuid": None, "kind": site, "v": "", "site": site, "title": f"{site} · {name}", "candidates": cands}


def parse_image_url(raw: str):
    return parse_caveduck_url(raw) or parse_generic_url(raw)


def looks_like_html(text: str) -> bool:
    if re.search(r"<(html|head|body|script|div|img|meta)[\s>]", text, re.I):
        return True
    if "__NEXT_DATA__" in text or "self.__next_f" in text:
        return True
    n = text.count("cdn.caveduck.io")
    return n >= 2 and bool(re.search(r'["{}]', text)) and len(text.split("\n")) < n * 2


DESC_KEYS = ["imageNameInternal", "imageName", "imageDescription", "imageCaption", "imagePrompt", "alt"]


def extract_from_html(src: str):
    s = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), src)
    s = re.sub(r'\\+"', '"', s)
    s = re.sub(r"\\+/", "/", s)
    s = s.replace("&quot;", '"').replace("&#x2F;", "/").replace("&#47;", "/").replace("&amp;", "&")
    by, positions = {}, []

    def add(uuid, url, pos):
        uuid = uuid.lower()
        e = by.setdefault(uuid, {"uuid": uuid, "urls": [], "descriptions": [], "pos": pos})
        if url and url not in e["urls"]:
            e["urls"].append(url)
        positions.append((uuid, pos))

    for m in re.finditer(r"https?://cdn\.caveduck\.io/[^\s\"'<>\\)`]+", s, re.I):
        p = parse_caveduck_url(m.group(0))
        if p and p["uuid"]:
            add(p["uuid"], clean_input(m.group(0)), m.start())
    for m in re.finditer(r"(?:^|[^\w.-])(charim(?:-[a-z0-9x]+)*)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", s, re.I):
        uuid = m.group(2).lower()
        add(uuid, None if uuid in by else f"https://{CDN_HOST}/{m.group(1)}/{uuid}", m.start())
    key_re = re.compile(r'"(' + "|".join(DESC_KEYS) + r')"\s*:\s*"((?:[^"\\]|\\.){0,2000}?)"')
    for m in key_re.finditer(s):
        val = m.group(2).strip()
        if not val or val.startswith("http"):
            continue
        best = None
        for uuid, pos in positions:
            d = abs(pos - m.start())
            if d < 3000 and (best is None or d < best[1]):
                best = (uuid, d)
        if best:
            e = by[best[0]]
            item = {"key": m.group(1), "value": val}
            if item not in e["descriptions"]:
                e["descriptions"].append(item)
    out = sorted(by.values(), key=lambda e: e["pos"])
    for e in out:
        e.pop("pos")
        e["parsed"] = parse_caveduck_url(e["urls"][0] if e["urls"] else f"https://{CDN_HOST}/charim/{e['uuid']}")
    return out


# ───────────────────────── 메타데이터 파서 ─────────────────────────

def dec_text(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("latin-1")


def detect_format(b: bytes):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG", "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "JPEG", "image/jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "WebP", "image/webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF", "image/gif"
    if b[4:8] == b"ftyp":
        brand = b[8:12].decode("latin-1")
        if brand.startswith("avi"):
            return "AVIF", "image/avif"
        return "HEIF", "image/heif"
    head = b[:256].lstrip().lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        return "HTML", "text/html"
    return "알 수 없음", "application/octet-stream"


EXIF_TAGS = {
    0x010E: "ImageDescription", 0x010F: "Make", 0x0110: "Model", 0x0131: "Software", 0x0132: "DateTime",
    0x013B: "Artist", 0x8298: "Copyright", 0x9C9B: "XPTitle", 0x9C9C: "XPComment", 0x9C9D: "XPAuthor",
    0x9C9E: "XPKeywords", 0x9C9F: "XPSubject", 0x9286: "UserComment", 0x9003: "DateTimeOriginal",
}
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}


def decode_user_comment(b: bytes, le_tiff=False) -> str:
    if len(b) < 8:
        return dec_text(b).rstrip("\0")
    code, data = b[:8], b[8:]
    if code.startswith(b"UNICODE"):
        sample = data[:400]
        even = sum(1 for i in range(0, len(sample) - 1, 2) if sample[i] == 0)
        odd = sum(1 for i in range(0, len(sample) - 1, 2) if sample[i + 1] == 0)
        le = le_tiff if even == odd else odd > even
        return data.decode("utf-16-le" if le else "utf-16-be", "replace").rstrip("\0")
    if code.startswith(b"ASCII") or code == b"\0" * 8:
        return dec_text(data).rstrip("\0")
    if code.startswith(b"JIS"):
        return data.decode("shift_jis", "replace").rstrip("\0")
    return dec_text(b).rstrip("\0")


def parse_exif(b: bytes):
    out = []
    if b.startswith(b"Exif\0\0"):
        b = b[6:]
    if len(b) < 8 or b[:2] not in (b"II", b"MM"):
        return out
    le = b[:2] == b"II"
    e16, e32 = ("<H", "<I") if le else (">H", ">I")
    u16 = lambda o: struct.unpack_from(e16, b, o)[0]
    u32 = lambda o: struct.unpack_from(e32, b, o)[0]
    visited = set()

    def ifd(off, name):
        if not off or off + 2 > len(b) or off in visited:
            return
        visited.add(off)
        n = u16(off)
        for i in range(n):
            e = off + 2 + i * 12
            if e + 12 > len(b):
                break
            tag, typ, cnt = u16(e), u16(e + 2), u32(e + 4)
            if tag == 0x8769:
                ifd(u32(e + 8), "Exif")
                continue
            tname = EXIF_TAGS.get(tag)
            if not tname:
                continue
            size = TYPE_SIZE.get(typ, 1) * cnt
            voff = e + 8 if size <= 4 else u32(e + 8)
            if voff + size > len(b):
                continue
            raw = b[voff:voff + size]
            if tag == 0x9286:
                val = decode_user_comment(raw, le)
            elif tname.startswith("XP"):
                val = raw.decode("utf-16-le", "replace").rstrip("\0")
            else:
                val = dec_text(raw).rstrip("\0")
            if val.strip():
                out.append({"source": f"EXIF {name}", "key": tname, "value": val})
        if name == "IFD0":
            nxt = off + 2 + n * 12
            if nxt + 4 <= len(b):
                ifd(u32(nxt), "IFD1")

    ifd(u32(4), "IFD0")
    return out


XMP_FIELDS = ["dc:description", "dc:title", "dc:subject", "exif:UserComment", "xmp:CreatorTool",
              "tiff:ImageDescription", "photoshop:Instructions", "Iptc4xmpExt:AOSource", "parameters"]


def xmp_entries(xmp: str, source: str):
    out = [{"source": source, "key": "XMP", "value": xmp}]
    for f in XMP_FIELDS:
        esc = re.escape(f)
        m = re.search(rf'\s{esc}="([^"]*)"', xmp)
        if m and m.group(1).strip():
            out.append({"source": source + " 필드", "key": f, "value": htmlmod.unescape(m.group(1))})
            continue
        m = re.search(rf"<{esc}(?:\s[^>]*)?>([\s\S]*?)</{esc}>", xmp)
        if m:
            lis = re.findall(r"<rdf:li[^>]*>([\s\S]*?)</rdf:li>", m.group(1))
            v = htmlmod.unescape(re.sub(r"<[^>]+>", "", ", ".join(lis) if lis else m.group(1)).strip())
            if v:
                out.append({"source": source + " 필드", "key": f, "value": v})
    return out


def parse_png(b: bytes, res):
    off = 8
    while off + 12 <= len(b):
        ln, = struct.unpack_from(">I", b, off)
        typ = b[off + 4:off + 8].decode("latin-1")
        d = b[off + 8:off + 8 + ln]
        if off + 12 + ln > len(b):
            res["notes"].append(f"PNG {typ} 청크가 잘려 있습니다")
            break
        try:
            if typ == "IHDR":
                res["width"], res["height"] = struct.unpack_from(">II", d)
                res["hasAlpha"] = d[9] in (4, 6)
            elif typ == "tRNS":
                res["hasAlpha"] = True
            elif typ == "acTL":
                res["animated"] = True
            elif typ == "tEXt":
                k, _, v = d.partition(b"\0")
                res["entries"].append({"source": "PNG tEXt", "key": k.decode("latin-1"), "value": dec_text(v)})
            elif typ == "zTXt":
                k, _, rest = d.partition(b"\0")
                res["entries"].append({"source": "PNG zTXt", "key": k.decode("latin-1"), "value": dec_text(zlib.decompress(rest[1:]))})
            elif typ == "iTXt":
                k, _, rest = d.partition(b"\0")
                comp = rest[0] == 1
                lang, _, rest = rest[2:].partition(b"\0")
                tkey, _, text = rest.partition(b"\0")
                if comp:
                    text = zlib.decompress(text)
                val = text.decode("utf-8", "replace")
                src = "PNG iTXt(압축)" if comp else "PNG iTXt"
                key = k.decode("latin-1")
                if key == "XML:com.adobe.xmp":
                    res["entries"] += xmp_entries(val, src)
                else:
                    e = {"source": src, "key": key, "value": val}
                    if lang or tkey:
                        e.update(lang=lang.decode("latin-1"), translatedKey=tkey.decode("utf-8", "replace"))
                    res["entries"].append(e)
            elif typ == "eXIf":
                res["entries"] += [{**e, "source": "PNG eXIf/" + e["source"]} for e in parse_exif(d)]
            elif typ == "IEND":
                break
        except Exception as err:  # noqa: BLE001
            res["notes"].append(f"PNG {typ} 청크 해석 실패: {err}")
        off += 12 + ln


def parse_jpeg(b: bytes, res):
    off = 2
    while off + 4 <= len(b):
        if b[off] != 0xFF:
            off += 1
            continue
        mk = b[off + 1]
        if mk == 0xFF:
            off += 1
            continue
        if mk in (0xD8, 0x01) or 0xD0 <= mk <= 0xD7:
            off += 2
            continue
        if mk in (0xD9, 0xDA):
            break
        ln = (b[off + 2] << 8) | b[off + 3]
        d = b[off + 4:off + 2 + ln]
        if 0xC0 <= mk <= 0xCF and mk not in (0xC4, 0xC8, 0xCC):
            res["height"], res["width"] = struct.unpack_from(">HH", d, 1)
        elif mk == 0xE1 and d.startswith(b"Exif\0"):
            res["entries"] += parse_exif(d[6:])
        elif mk == 0xE1 and d.startswith(b"http://ns.adobe.com/xap/1.0/\0"):
            res["entries"] += xmp_entries(d[29:].decode("utf-8", "replace"), "JPEG XMP")
        elif mk == 0xFE:
            res["entries"].append({"source": "JPEG COM", "key": "Comment", "value": dec_text(d)})
        off += 2 + ln


def parse_webp(b: bytes, res):
    off = 12
    while off + 8 <= len(b):
        typ = b[off:off + 4].decode("latin-1")
        ln, = struct.unpack_from("<I", b, off + 4)
        d = b[off + 8:off + 8 + ln]
        if typ == "VP8X":
            res["width"] = 1 + int.from_bytes(d[4:7], "little")
            res["height"] = 1 + int.from_bytes(d[7:10], "little")
            res["hasAlpha"] = bool(d[0] & 0x10)
            res["animated"] = bool(d[0] & 0x02)
        elif typ == "VP8 " and res.get("width") is None and len(d) >= 10:
            res["width"] = int.from_bytes(d[6:8], "little") & 0x3FFF
            res["height"] = int.from_bytes(d[8:10], "little") & 0x3FFF
        elif typ == "VP8L" and res.get("width") is None and len(d) >= 5:
            bits = int.from_bytes(d[1:5], "little")
            res["width"], res["height"] = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            res["hasAlpha"] = bool((bits >> 28) & 1)
        elif typ == "EXIF":
            res["entries"] += [{**e, "source": "WebP " + e["source"]} for e in parse_exif(d)]
        elif typ == "XMP ":
            res["entries"] += xmp_entries(d.decode("utf-8", "replace"), "WebP XMP")
        off += 8 + ln + (ln & 1)


def parse_gif(b: bytes, res):
    res["width"], res["height"] = struct.unpack_from("<HH", b, 6)
    off = 13
    if b[10] & 0x80:
        off += 3 * (1 << ((b[10] & 7) + 1))
    frames = 0

    def sub(o):
        parts = []
        while o < len(b):
            n = b[o]
            o += 1
            if n == 0:
                break
            parts.append(b[o:o + n])
            o += n
        return o, b"".join(parts)

    while off < len(b):
        c = b[off]
        off += 1
        if c == 0x3B:
            break
        if c == 0x21:
            label = b[off]
            off += 1
            off, data = sub(off)
            if label == 0xFE:
                res["entries"].append({"source": "GIF Comment", "key": "Comment", "value": dec_text(data)})
        elif c == 0x2C:
            frames += 1
            packed = b[off + 8]
            off += 9
            if packed & 0x80:
                off += 3 * (1 << ((packed & 7) + 1))
            off, _ = sub(off + 1)
        else:
            break
    res["frames"], res["animated"] = frames, frames > 1


# ───────────────────────── 해석 ─────────────────────────

def try_json(s):
    t = s.strip() if isinstance(s, str) else ""
    if not t.startswith(("{", "[")):
        return None
    try:
        return json.loads(t)
    except ValueError:
        return None


def parse_a1111(text: str):
    lines = text.strip().split("\n")
    settings = lines.pop() if lines and re.search(r"(^|,\s*)Steps:\s*\d+", lines[-1]) else ""
    prompt, neg, in_neg = [], [], False
    for l in lines:
        if l.startswith("Negative prompt:"):
            in_neg = True
            neg.append(l[16:].lstrip())
            continue
        (neg if in_neg else prompt).append(l)
    params = {}
    for m in re.finditer(r'\s*([\w ]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)', settings):
        if not m.group(1):
            continue
        v = m.group(2).strip()
        if v.startswith('"'):
            try:
                v = json.loads(v)
            except ValueError:
                pass
        params[m.group(1).strip()] = v
    return {"prompt": "\n".join(prompt).strip(), "negative": "\n".join(neg).strip(), "params": params}


def looks_like_a1111(t):
    return isinstance(t, str) and bool(re.search(r"(^|\n)(Negative prompt:|Steps:\s*\d+,)|,\s*Sampler:\s|,\s*CFG scale:\s", t))


NAI_KEYS = ["steps", "scale", "cfg_rescale", "seed", "sampler", "noise_schedule", "width", "height", "strength", "noise",
            "sm", "sm_dyn", "n_samples", "uncond_scale", "dynamic_thresholding", "skip_cfg_above_sigma", "request_type", "version"]


def summarize_nai(c, extras=None):
    extras = extras or {}
    c = try_json(c) or {} if isinstance(c, str) else (c or {})
    params = {k: c[k] for k in NAI_KEYS if c.get(k) is not None}
    for k in ("Software", "Source"):
        if extras.get(k):
            params[k] = extras[k]
    v4 = (c.get("v4_prompt") or {}).get("caption") or {}
    v4n = (c.get("v4_negative_prompt") or {}).get("caption") or {}
    nchars = v4n.get("char_captions") or []
    chars = [{"prompt": ch.get("char_caption", ""),
              "negative": nchars[i].get("char_caption", "") if i < len(nchars) else "",
              "centers": " ".join(f"({p.get('x')}, {p.get('y')})" for p in ch.get("centers") or [])}
             for i, ch in enumerate(v4.get("char_captions") or [])]
    return {"type": "NovelAI", "title": "NovelAI",
            "prompt": v4.get("base_caption") or c.get("prompt") or extras.get("Description", ""),
            "negative": v4n.get("base_caption") or c.get("uc", ""), "params": params, "characters": chars}


def summarize_comfy(g):
    if not isinstance(g, dict):
        return None

    def text_of(ref, depth=0):
        if isinstance(ref, str):
            return ref
        if not isinstance(ref, list) or not ref or depth > 6:
            return ""
        n = g.get(str(ref[0])) or {}
        inp = n.get("inputs") or {}
        for k in ("text", "text_g", "prompt", "positive", "string", "value", "conditioning", "conditioning_1", "conditioning_to"):
            if k in inp:
                t = text_of(inp[k], depth + 1)
                if t:
                    return t
        return ""

    params, prompt, neg = {}, "", ""
    for nid, n in g.items():
        if not isinstance(n, dict) or not re.search(r"Sampler", n.get("class_type", ""), re.I):
            continue
        i = n.get("inputs") or {}
        prompt = prompt or text_of(i.get("positive"))
        neg = neg or text_of(i.get("negative"))
        for k in ("seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"):
            if k in i and not isinstance(i[k], (list, dict)):
                params.setdefault(k, i[k])
        params.setdefault("sampler_node", f"{n.get('class_type')} #{nid}")
    loras = []
    for n in g.values():
        i = (n or {}).get("inputs") or {} if isinstance(n, dict) else {}
        if isinstance(i.get("ckpt_name"), str):
            params.setdefault("checkpoint", i["ckpt_name"])
        if isinstance(i.get("lora_name"), str):
            loras.append(f"{i['lora_name']} ({i.get('strength_model', '')})")
        if "EmptyLatentImage" in (n.get("class_type", "") if isinstance(n, dict) else "") and isinstance(i.get("width"), int):
            params["size"] = f"{i['width']}x{i['height']}"
    if loras:
        params["loras"] = ", ".join(loras)
    return {"type": "ComfyUI", "title": "ComfyUI", "prompt": prompt, "negative": neg, "params": params, "characters": []}


GEN_KEYS = {"parameters", "prompt", "workflow", "Comment", "Description", "UserComment", "invokeai_metadata", "sd-metadata",
            "Dream", "generation_data", "XPComment", "ImageDescription", "exif:UserComment", "dc:description", "tiff:ImageDescription"}


def interpret(entries):
    summaries = []
    by = {}
    for e in entries:
        by.setdefault(e["key"], e["value"])
    is_nai = "NovelAI" in by.get("Software", "") or "NovelAI" in by.get("Title", "") or \
        bool(re.search(r'"(uc|v4_prompt|n_samples|noise_schedule)"', by.get("Comment", "")))
    if is_nai:
        summaries.append(summarize_nai(by.get("Comment", "{}"), by))
    for e in entries:
        if e["key"] == "parameters" or (e["key"] in ("UserComment", "Comment", "Description", "ImageDescription", "exif:UserComment")
                                        and looks_like_a1111(e["value"])):
            if is_nai and e["key"] != "parameters":
                continue
            summaries.append({"type": "SD-WebUI", "title": f"Stable Diffusion WebUI 계열 ({e['source']} · {e['key']})",
                              **parse_a1111(e["value"]), "characters": []})
    comfy = next((e for e in entries if e["key"] == "prompt" and isinstance(try_json(e["value"]), dict)
                  and any(isinstance(n, dict) and "class_type" in n for n in try_json(e["value"]).values())), None)
    if comfy:
        summaries.append(summarize_comfy(try_json(comfy["value"])))
    for e in entries:
        if e["source"].startswith("PNG") or e is comfy or e["key"] == "workflow" or (is_nai and e["key"] == "Comment"):
            continue
        j = try_json(e["value"])
        if isinstance(j, dict):
            if any(isinstance(n, dict) and "class_type" in n for n in j.values()):
                summaries.append(summarize_comfy(j))
            elif "uc" in j or "v4_prompt" in j:
                summaries.append(summarize_nai(j))
    has = bool(summaries) or any(e["key"] in GEN_KEYS and str(e["value"]).strip()
                                 and not (e["key"] == "ImageDescription" and len(e["value"]) < 4) for e in entries)
    return summaries, has


STEALTH_SIGS = {"stealth_pnginfo": ("alpha", False), "stealth_pngcomp": ("alpha", True),
                "stealth_rgbinfo": ("rgb", False), "stealth_rgbcomp": ("rgb", True)}


def read_stealth(path_or_bytes):
    """Pillow 로 픽셀 LSB 에 숨겨진 stealth pnginfo 를 읽는다 (없으면 None)."""
    if Image is None:
        return None
    import io
    im = Image.open(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else path_or_bytes)
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    for mode in ("alpha", "rgb"):
        per = 1 if mode == "alpha" else 3
        total = w * h * per

        def bits(start, count):
            out = []
            for n in range(start, start + count):
                if n >= total:
                    return None
                p = n // per
                x, y = p // h, p % h
                r, g, b, a = px[x, y]
                out.append((a if mode == "alpha" else (r, g, b)[n % per]) & 1)
            return out

        def to_bytes(bs):
            return bytes(int("".join(map(str, bs[i:i + 8])), 2) for i in range(0, len(bs), 8))

        sb = bits(0, 120)
        if not sb:
            continue
        sig = to_bytes(sb).decode("latin-1")
        if sig not in STEALTH_SIGS or STEALTH_SIGS[sig][0] != mode:
            continue
        lb = bits(120, 32)
        if not lb:
            return None
        ln = int("".join(map(str, lb)), 2)
        if not ln or ln > total:
            return None
        db = bits(152, ln - ln % 8)
        if not db:
            return None
        data = to_bytes(db)
        if STEALTH_SIGS[sig][1]:
            data = gzip.decompress(data)
        return {"mode": mode, "compressed": STEALTH_SIGS[sig][1], "text": data.decode("utf-8", "replace")}
    return None


def stealth_entries(st):
    src = f"Stealth({st['mode']}{', gzip' if st['compressed'] else ''})"
    j = try_json(st["text"])
    if isinstance(j, dict):
        return [{"source": src, "key": k, "value": v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)} for k, v in j.items()]
    return [{"source": src, "key": "parameters", "value": st["text"]}]


def parse_image(b: bytes, stealth=True):
    fmt, mime = detect_format(b)
    res = {"format": fmt, "mime": mime, "size": len(b), "width": None, "height": None, "entries": [], "notes": []}
    try:
        {"PNG": parse_png, "JPEG": parse_jpeg, "WebP": parse_webp, "GIF": parse_gif}.get(fmt, lambda *_: None)(b, res)
        if fmt == "HTML":
            res["notes"].append("이미지가 아니라 HTML 응답입니다.")
    except Exception as err:  # noqa: BLE001
        res["notes"].append(f"파싱 중 오류: {err}")
    if not any(e["key"] == "XMP" for e in res["entries"]):
        s = b[: 4 << 20]
        a = s.find(b"<x:xmpmeta")
        z = s.find(b"</x:xmpmeta>", a) if a >= 0 else -1
        if a >= 0 and z > a:
            res["entries"] += xmp_entries(s[a:z + 12].decode("utf-8", "replace"), f"{fmt} XMP(원문 검색)")
    if res["width"] is None and Image is not None and fmt not in ("HTML",):
        try:
            import io
            res["width"], res["height"] = Image.open(io.BytesIO(b)).size
        except Exception:  # noqa: BLE001
            pass
    summaries, has = interpret(res["entries"])
    if stealth and not has and fmt in ("PNG", "WebP"):
        try:
            st = read_stealth(b)
            if st:
                res["entries"] += stealth_entries(st)
                summaries, has = interpret(res["entries"])
        except Exception as err:  # noqa: BLE001
            res["notes"].append(f"stealth 검사 실패: {err}")
    res["summaries"], res["hasGenerationInfo"] = summaries, has
    return res


# ───────────────────────── 네트워크 ─────────────────────────

def fetch(url, proxy=None, timeout=30, max_bytes=50 << 20):
    target = url
    if proxy:
        target = proxy.replace("{url}", urllib.parse.quote(url, safe="")) if "{url}" in proxy else \
            proxy + ("&" if "?" in proxy else "?") + "url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(target, headers={"User-Agent": UA, "Accept": "*/*", "Referer": "https://caveduck.io/"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(max_bytes + 1)
            if len(data) > max_bytes:
                return {"ok": False, "status": r.status, "error": f"{max_bytes} 바이트 초과"}
            return {"ok": True, "status": r.status, "data": data,
                    "headers": {k.lower(): v for k, v in r.headers.items()
                                if k.lower() in ("content-type", "content-length", "cf-polished", "cf-cache-status", "last-modified")}}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "error": str(e.reason)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "status": None, "error": str(e)}


# ───────────────────────── 출력 ─────────────────────────

C = {"b": "\033[1m", "d": "\033[2m", "g": "\033[32m", "y": "\033[33m", "r": "\033[31m", "c": "\033[36m", "0": "\033[0m"}


def col(s, *k):
    if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
        return s
    return "".join(C[x] for x in k) + s + C["0"]


def human(n):
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB" if n < 1 << 20 else f"{n / (1 << 20):.2f} MB"


def print_meta(res, raw=False, max_len=4000):
    dims = f"{res['width']}×{res['height']}" if res["width"] else "?"
    extra = " · 애니메이션" if res.get("animated") else ""
    print(f"  형식 {col(res['format'], 'b')} · {dims} · {human(res['size'])}{extra}")
    for n in res["notes"]:
        print(col(f"  ! {n}", "r"))
    if not res["hasGenerationInfo"]:
        print(col("  ✖ 이 파일에는 생성 정보가 없음 (업로드·변환 과정에서 제거됐을 가능성)", "y", "b"))
    for s in res["summaries"]:
        print(col(f"\n  ■ {s['title']}", "c", "b"))
        if s.get("prompt"):
            print(col("  [프롬프트]", "b"))
            print(indent(s["prompt"]))
        if s.get("negative"):
            print(col("  [네거티브]", "b"))
            print(indent(s["negative"]))
        for i, c in enumerate(s.get("characters") or []):
            print(col(f"  [캐릭터 {i + 1}] {c.get('centers', '')}", "b"))
            print(indent(c["prompt"]))
            if c.get("negative"):
                print(indent("(네거티브) " + c["negative"]))
        if s.get("params"):
            print(col("  [설정]", "b"))
            w = max(len(k) for k in s["params"])
            for k, v in s["params"].items():
                print(f"    {k.ljust(w)} : {v}")
    show = res["entries"] if raw else [e for e in res["entries"] if e["key"] != "XMP" or not res["summaries"]]
    if show:
        print(col("\n  [메타데이터 항목]", "b"))
        for e in show:
            v = e["value"]
            j = try_json(v)
            if j is not None:
                v = json.dumps(j, ensure_ascii=False, indent=2)
            if not raw and len(v) > max_len:
                v = v[:max_len] + f"\n… ({len(v):,}자 중 {max_len:,}자만 표시, --raw 로 전체)"
            print(col(f"  · {e['source']} / {e['key']}", "d"))
            print(indent(v, 6))


def indent(s, n=4):
    return "\n".join(" " * n + l for l in str(s).split("\n"))


def export(res, extra=None):
    return {**(extra or {}), "file": {k: res.get(k) for k in ("format", "mime", "width", "height", "size", "animated", "hasAlpha")},
            "hasGenerationInfo": res["hasGenerationInfo"], "summaries": res["summaries"], "entries": res["entries"], "notes": res["notes"]}


# ───────────────────────── 메인 ─────────────────────────

def process_url(parsed, args, results, descriptions=None):
    print(col(f"\n━━ {parsed.get('uuid') or parsed.get('title') or parsed['input']}", "b"))
    print(col(f"   입력: {parsed['input']}", "d"))
    for d in descriptions or []:
        print(f"   {d['key']}: {d['value']}")
    item = {"input": parsed["input"], "uuid": parsed.get("uuid"), "descriptions": descriptions or [], "candidates": []}
    found = False
    for i, c in enumerate(parsed["candidates"], 1):
        rec = {"url": c["url"], "label": c["label"]}
        item["candidates"].append(rec)
        if found and not args.all:
            print(col(f"   {i}. {c['label']:18s} 건너뜀  {c['url']}", "d"))
            continue
        r = fetch(c["url"], args.proxy, args.timeout)
        rec.update(status=r["status"], ok=r["ok"], error=r.get("error"), headers=r.get("headers"))
        if not r["ok"]:
            print(f"   {i}. {c['label']:18s} " + col(f"✖ {r['status'] or ''} {r.get('error', '')}", "r") + f"  {c['url']}")
            continue
        ct = r["headers"].get("content-type", "")
        pol = f" cf-polished={r['headers']['cf-polished']}" if r["headers"].get("cf-polished") else ""
        print(f"   {i}. {c['label']:18s} " + col(f"✔ {r['status']} {ct}{pol}", "g") + f"  {c['url']}")
        res = parse_image(r["data"], stealth=not args.no_stealth)
        rec["result"] = export(res)
        print_meta(res, raw=args.raw)
        if args.save:
            ext = {"PNG": "png", "JPEG": "jpg", "WebP": "webp", "GIF": "gif", "AVIF": "avif"}.get(res["format"], "bin")
            p = Path(args.save) / f"{parsed.get('uuid') or 'image'}_{c['kind'] or 'x'}.{ext}"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(r["data"])
            print(col(f"   → 저장: {p}", "d"))
        if res["format"] != "HTML":
            found = True
        print()
    if not found:
        print(col("   어느 후보에서도 이미지를 받지 못했습니다.", "r"))
    results.append(item)


def process_file(path: Path, args, results):
    data = path.read_bytes()
    fmt, _ = detect_format(data)
    if fmt == "HTML" or path.suffix.lower() in (".html", ".htm", ".txt", ".json"):
        text = data.decode("utf-8", "replace")
        if fmt == "HTML" or looks_like_html(text):
            return process_text(text, args, results)
    print(col(f"\n━━ 파일: {path}", "b"))
    res = parse_image(data, stealth=not args.no_stealth)
    print_meta(res, raw=args.raw)
    results.append({"input": str(path), "result": export(res)})


def process_text(text, args, results):
    if looks_like_html(text):
        found = extract_from_html(text)
        print(col(f"\nHTML 소스에서 이미지 {len(found)}개를 찾았습니다.", "b"))
        for f in found:
            desc = " / ".join(d["value"] for d in f["descriptions"])
            print(f"  · {f['uuid']}  {desc}")
        if args.list_only:
            results.extend({"uuid": f["uuid"], "urls": f["urls"], "descriptions": f["descriptions"],
                            "candidates": [c["url"] for c in f["parsed"]["candidates"]]} for f in found)
            return
        for f in found:
            process_url(f["parsed"], args, results, f["descriptions"])
        return
    for line in text.splitlines():
        if line.strip():
            handle(line.strip(), args, results)


def handle(arg, args, results):
    p = Path(arg)
    if not re.match(r"^https?://", arg) and p.exists() and p.is_file():
        return process_file(p, args, results)
    parsed = parse_image_url(arg)
    if not parsed:
        if looks_like_html(arg):
            return process_text(arg, args, results)
        print(col(f"\n✖ 이미지 주소(https://…)나 파일이 아님: {arg}", "r"))
        results.append({"input": arg, "error": "인식 불가"})
        return
    process_url(parsed, args, results)


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description="caveduck.io 이미지 원본 주소 찾기 + AI 생성 메타데이터 출력")
    ap.add_argument("inputs", nargs="+", help="이미지 URL, 이미지 파일, HTML 파일, 또는 - (표준입력)")
    ap.add_argument("--all", action="store_true", help="첫 성공에서 멈추지 않고 모든 후보를 받아서 검사")
    ap.add_argument("--json", metavar="FILE", help="결과를 JSON 으로 저장 (- 이면 표준출력)")
    ap.add_argument("--save", metavar="DIR", help="받은 이미지 파일을 DIR 에 저장")
    ap.add_argument("--proxy", metavar="URL", help="프록시 주소 (예: https://x.workers.dev, {url} 치환 지원)")
    ap.add_argument("--raw", action="store_true", help="긴 메타데이터도 자르지 않고 전부 출력")
    ap.add_argument("--list-only", action="store_true", help="HTML 소스 모드에서 이미지 목록만 출력")
    ap.add_argument("--no-stealth", action="store_true", help="픽셀 LSB 의 stealth pnginfo 검사를 하지 않음")
    ap.add_argument("--timeout", type=float, default=30, help="요청 타임아웃(초)")
    args = ap.parse_args(argv)

    results = []
    real_stdout = sys.stdout
    if args.json == "-":
        sys.stdout = sys.stderr  # 사람이 읽는 출력은 stderr 로
    try:
        for a in args.inputs:
            if a == "-":
                process_text(sys.stdin.read(), args, results)
            else:
                handle(a, args, results)
    finally:
        sys.stdout = real_stdout
    if args.json:
        out = json.dumps(results, ensure_ascii=False, indent=2)
        if args.json == "-":
            print(out)
        else:
            Path(args.json).write_text(out, encoding="utf-8")
            print(col(f"\nJSON 저장: {args.json}", "d"))
    ok = any(r.get("result") or any(c.get("ok") for c in r.get("candidates", [])) for r in results)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
