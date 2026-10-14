#!/usr/bin/env python3
"""파서 테스트용 샘플 이미지 생성 (Pillow 필요).

    python tests/gen_fixtures.py

tests/fixtures/ 아래에 PNG(tEXt/iTXt/zTXt), JPEG(EXIF/XMP/COM), WebP(EXIF/XMP), GIF(Comment),
NovelAI 형식, ComfyUI 형식, stealth pnginfo, 메타데이터 없는 파일을 만든다.
"""
import gzip
import json
import struct
import zlib
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

OUT = Path(__file__).resolve().parent / "fixtures"

A1111 = (
    "masterpiece, 1girl, 한국어 프롬프트, smile\n"
    "Negative prompt: lowres, bad hands\n"
    'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567890, Size: 512x768, '
    'Model hash: abcdef1234, Model: animeModel_v1, Lora hashes: "foo: 1a2b, bar: 3c4d", Version: v1.10.1'
)

NAI_COMMENT = {
    "prompt": "1girl, silver hair, caveduck",
    "steps": 28, "height": 1216, "width": 832, "scale": 5.0, "uncond_scale": 1.0, "cfg_rescale": 0.0,
    "seed": 42, "n_samples": 1, "noise_schedule": "karras", "sampler": "k_euler_ancestral",
    "uc": "lowres, worst quality",
    "v4_prompt": {"caption": {"base_caption": "1girl, silver hair, caveduck",
                              "char_captions": [{"char_caption": "girl, red eyes", "centers": [{"x": 0.5, "y": 0.5}]}]},
                  "use_coords": False, "use_order": True},
    "v4_negative_prompt": {"caption": {"base_caption": "lowres, worst quality",
                                       "char_captions": [{"char_caption": "blurry", "centers": [{"x": 0.5, "y": 0.5}]}]}},
}

COMFY_PROMPT = {
    "3": {"class_type": "KSampler", "inputs": {"seed": 777, "steps": 20, "cfg": 6.5, "sampler_name": "euler",
                                               "scheduler": "normal", "denoise": 1, "model": ["4", 0],
                                               "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl_base.safetensors"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat in a cave", "clip": ["4", 1]}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "ugly, blurry", "clip": ["4", 1]}},
}
COMFY_WORKFLOW = {"last_node_id": 7, "nodes": [{"id": 3, "type": "KSampler"}, {"id": 6, "type": "CLIPTextEncode"}], "links": []}

XMP = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
    'xmp:CreatorTool="TestTool 1.0"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">xmp prompt &amp; test</rdf:li>'
    '</rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def img(mode="RGB", size=(8, 6)):
    return Image.new(mode, size, (200, 100, 50) if mode == "RGB" else (200, 100, 50, 255))


def user_comment_unicode(text, big_endian=True):
    return b"UNICODE\0" + text.encode("utf-16-be" if big_endian else "utf-16-le")


def exif_with(user_comment=None, description=None, software=None):
    ex = Image.Exif()
    if description:
        ex[0x010E] = description
    if software:
        ex[0x0131] = software
    if user_comment is not None:
        ex.get_ifd(0x8769)[0x9286] = user_comment
    return ex


def png_chunk(ctype, data):
    return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)


def insert_chunks_before_idat(png_bytes, chunks):
    i = png_bytes.index(b"IDAT") - 4
    return png_bytes[:i] + b"".join(chunks) + png_bytes[i:]


def embed_stealth(im, text, compressed=True, mode="alpha"):
    """sd-webui-stealth-pnginfo / NovelAI 방식(열 우선, LSB)으로 텍스트를 숨긴다."""
    im = im.convert("RGBA")
    data = text.encode("utf-8")
    if compressed:
        data = gzip.compress(data, mtime=0)
    sig = {("alpha", False): "stealth_pnginfo", ("alpha", True): "stealth_pngcomp",
           ("rgb", False): "stealth_rgbinfo", ("rgb", True): "stealth_rgbcomp"}[(mode, compressed)]
    bits = "".join(f"{b:08b}" for b in sig.encode()) + f"{len(data) * 8:032b}" + "".join(f"{b:08b}" for b in data)
    w, h = im.size
    px = im.load()
    per = 1 if mode == "alpha" else 3
    assert len(bits) <= w * h * per, "이미지가 너무 작음"
    i = 0
    for x in range(w):
        for y in range(h):
            r, g, b, a = px[x, y]
            if mode == "alpha":
                if i < len(bits):
                    a = (a & ~1) | int(bits[i]); i += 1
            else:
                ch = [r, g, b]
                for k in range(3):
                    if i < len(bits):
                        ch[k] = (ch[k] & ~1) | int(bits[i]); i += 1
                r, g, b = ch
            px[x, y] = (r, g, b, a)
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # 1) A1111: tEXt parameters
    info = PngInfo()
    info.add_text("parameters", A1111.replace("한국어 프롬프트", "latin text"))
    info.add_text("Software", "TestSuite")
    img().save(OUT / "a1111_text.png", pnginfo=info)

    # 2) iTXt (비압축 UTF-8) + iTXt 압축 + zTXt
    info = PngInfo()
    info.add_itxt("parameters", A1111, lang="ko", tkey="매개변수", zip=False)
    info.add_itxt("Description", "압축 iTXt 설명 " * 20, zip=True)
    info.add_text("Comment", "zTXt comment " * 30, zip=True)  # zip=True → zTXt
    img().save(OUT / "itxt_ztxt.png", pnginfo=info)

    # 3) NovelAI
    info = PngInfo()
    info.add_text("Title", "NovelAI generated image")
    info.add_text("Description", NAI_COMMENT["prompt"])
    info.add_text("Software", "NovelAI")
    info.add_text("Source", "NovelAI Diffusion V4.5 4BDE2A90")
    info.add_text("Comment", json.dumps(NAI_COMMENT))
    img("RGBA").save(OUT / "novelai.png", pnginfo=info)

    # 4) ComfyUI
    info = PngInfo()
    info.add_text("prompt", json.dumps(COMFY_PROMPT))
    info.add_text("workflow", json.dumps(COMFY_WORKFLOW))
    img().save(OUT / "comfyui.png", pnginfo=info)

    # 5) PNG 에 XMP(iTXt XML:com.adobe.xmp) + eXIf
    buf = (OUT / "_tmp.png")
    img().save(buf)
    raw = buf.read_bytes()
    buf.unlink()
    xmp_itxt = b"XML:com.adobe.xmp\0\0\0\0\0" + XMP.encode()
    exif_bytes = exif_with(description="png exif description", software="ExifWriter").tobytes()
    (OUT / "png_xmp_exif.png").write_bytes(insert_chunks_before_idat(raw, [png_chunk(b"iTXt", xmp_itxt), png_chunk(b"eXIf", exif_bytes)]))

    # 6) JPEG: EXIF UserComment(UNICODE, BE) + ImageDescription + Software + XMP + COM
    ex = exif_with(user_comment=user_comment_unicode(A1111), description="jpeg description", software="SD WebUI")
    img().save(OUT / "a1111_exif.jpg", exif=ex.tobytes(), xmp=XMP.encode(), comment="jpeg COM 코멘트".encode())

    # 7) JPEG: UserComment UTF-16LE (일부 도구 방식)
    ex = exif_with(user_comment=user_comment_unicode("little endian comment, Steps: 5, Sampler: Euler", big_endian=False))
    img().save(OUT / "usercomment_le.jpg", exif=ex.tobytes())

    # 8) WebP: EXIF + XMP
    ex = exif_with(user_comment=user_comment_unicode(A1111), software="WebPWriter")
    img().save(OUT / "a1111.webp", exif=ex.tobytes(), xmp=XMP.encode(), lossless=True)

    # 9) WebP 손실, 메타데이터 없음 (CDN 변환본 흉내)
    img(size=(64, 40)).save(OUT / "plain.webp", quality=80)

    # 10) GIF 코멘트
    img().convert("P").save(OUT / "comment.gif", comment=b"gif comment text")

    # 11) 메타데이터 없는 PNG/JPEG
    img().save(OUT / "plain.png")
    img().save(OUT / "plain.jpg")

    # 12) stealth pnginfo (NovelAI 형식, gzip) — 텍스트 청크 없이 알파 LSB 에만 정보가 있음
    stealth_payload = json.dumps({"Description": NAI_COMMENT["prompt"], "Software": "NovelAI",
                                  "Source": "NovelAI Diffusion V4.5", "Comment": json.dumps(NAI_COMMENT)})
    embed_stealth(img("RGBA", (64, 64)), stealth_payload, compressed=True).save(OUT / "stealth_nai.png")
    embed_stealth(img("RGBA", (64, 64)), A1111, compressed=False, mode="rgb").save(OUT / "stealth_rgb.png")

    for p in sorted(OUT.iterdir()):
        print(f"{p.name:24s} {p.stat().st_size:7d} bytes")


if __name__ == "__main__":
    main()
