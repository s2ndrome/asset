"""CLI(파이썬 파서) 테스트:  python -m unittest discover -s tests -p "test_*.py"  (먼저 gen_fixtures.py 실행)"""
import contextlib
import io
import json
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "cli"))
import caveduck_meta as cm  # noqa: E402

FX = ROOT / "tests" / "fixtures"
UUID = "a1723c53-fe6f-4a8f-b058-13b84e0781ad"
EX = f"https://cdn.caveduck.io/cdn-cgi/image/anim=true,dpr=2,f=auto,w=800/charim-standard/{UUID}?v=47d447"


def parse(name):
    return cm.parse_image((FX / name).read_bytes())


def entry(res, key, src=""):
    return next(e for e in res["entries"] if e["key"] == key and src in e["source"])


class UrlTest(unittest.TestCase):
    def test_candidates(self):
        p = cm.parse_caveduck_url(EX + " |")
        self.assertEqual([c["url"] for c in p["candidates"]][:3], [
            f"https://cdn.caveduck.io/charim/{UUID}",
            f"https://cdn.caveduck.io/charim/{UUID}?v=47d447",
            f"https://cdn.caveduck.io/charim-1920x/{UUID}",
        ])
        self.assertIsNone(cm.parse_caveduck_url("https://example.com/x"))

    def test_html(self):
        html = (f'<html><img src="{EX}"><script>{{"imageNameInternal":"표정1",'
                f'"url":"https:\\/\\/cdn.caveduck.io\\/charim\\/{UUID}"}}</script></html>')
        found = cm.extract_from_html(html)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["descriptions"], [{"key": "imageNameInternal", "value": "표정1"}])


class GenericUrlTest(unittest.TestCase):
    def test_tistory_notion_generic(self):
        r = cm.parse_image_url("https://img1.daumcdn.net/thumb/R1280x0/?scode=mtistory2&fname=https%3A%2F%2Fblog.kakaocdn.net%2Fdn%2Fa%2Fb%2Fimg.png")
        self.assertEqual(r["candidates"][0]["url"], "https://blog.kakaocdn.net/dn/a/b/img.png")
        r = cm.parse_image_url("https://www.notion.so/image/https%3A%2F%2Fprod-files-secure.s3.us-west-2.amazonaws.com%2Fx%2Fi.png?table=block&id=1&width=640")
        self.assertEqual(r["candidates"][0]["url"], "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/i.png")
        self.assertNotIn("width=", r["candidates"][1]["url"])
        self.assertEqual(cm.parse_image_url("https://pbs.twimg.com/m/x.png")["candidates"][0]["url"], "https://pbs.twimg.com/m/x.png")
        self.assertIsNone(cm.parse_image_url("hello"))
        self.assertEqual(cm.parse_image_url(EX)["candidates"][0]["url"], f"https://cdn.caveduck.io/charim/{UUID}")


class ParserTest(unittest.TestCase):
    def test_png_text(self):
        r = parse("a1111_text.png")
        s = r["summaries"][0]
        self.assertEqual(s["params"]["Sampler"], "DPM++ 2M Karras")
        self.assertEqual(s["negative"], "lowres, bad hands")

    def test_itxt_ztxt(self):
        r = parse("itxt_ztxt.png")
        self.assertIn("한국어 프롬프트", entry(r, "parameters", "iTXt")["value"])
        self.assertTrue(entry(r, "Description", "압축")["value"].startswith("압축 iTXt"))
        self.assertTrue(entry(r, "Comment", "zTXt")["value"].startswith("zTXt comment"))

    def test_novelai(self):
        s = parse("novelai.png")["summaries"]
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]["negative"], "lowres, worst quality")
        self.assertEqual(s[0]["characters"][0]["prompt"], "girl, red eyes")

    def test_comfy(self):
        s = parse("comfyui.png")["summaries"][0]
        self.assertEqual((s["prompt"], s["negative"], s["params"]["seed"]), ("a cat in a cave", "ugly, blurry", 777))

    def test_jpeg(self):
        r = parse("a1111_exif.jpg")
        self.assertIn("한국어 프롬프트", entry(r, "UserComment")["value"])
        self.assertEqual(entry(r, "Comment", "COM")["value"], "jpeg COM 코멘트")
        self.assertEqual(entry(r, "dc:description")["value"], "xmp prompt & test")
        self.assertEqual(parse("usercomment_le.jpg")["entries"][0]["value"], "little endian comment, Steps: 5, Sampler: Euler")

    def test_webp_gif_png_xmp(self):
        r = parse("a1111.webp")
        self.assertEqual((r["width"], r["height"]), (8, 6))
        self.assertTrue(r["hasGenerationInfo"])
        self.assertEqual(entry(parse("comment.gif"), "Comment")["value"], "gif comment text")
        self.assertEqual(entry(parse("png_xmp_exif.png"), "ImageDescription", "eXIf")["value"], "png exif description")

    def test_plain(self):
        for n in ("plain.png", "plain.jpg", "plain.webp"):
            r = parse(n)
            self.assertFalse(r["hasGenerationInfo"], n)

    @unittest.skipIf(cm.Image is None, "Pillow 없음")
    def test_stealth(self):
        r = parse("stealth_nai.png")
        self.assertEqual(r["summaries"][0]["type"], "NovelAI")
        self.assertEqual(r["summaries"][0]["prompt"], "1girl, silver hair, caveduck")
        r = parse("stealth_rgb.png")
        self.assertEqual(r["summaries"][0]["negative"], "lowres, bad hands")


class FakeCdn(BaseHTTPRequestHandler):
    """?u=<cdn url> 를 받아 charim/ 은 404, charim-1920x/ 은 NovelAI PNG 를 돌려주는 가짜 프록시"""
    def do_GET(self):
        u = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)["u"][0]
        self.server.seen.append(u)
        if "/charim-1920x/" in u:
            body = (FX / "novelai.png").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


class EndToEndTest(unittest.TestCase):
    def test_candidates_via_proxy(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeCdn)
        srv.seen = []
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cm.main([EX, "--proxy", f"http://127.0.0.1:{srv.server_port}/?u={{url}}", "--json", "-"])
            self.assertEqual(code, 0)
            data = json.loads(out.getvalue())
            self.assertEqual(srv.seen[:3], [f"https://cdn.caveduck.io/charim/{UUID}",
                                            f"https://cdn.caveduck.io/charim/{UUID}?v=47d447",
                                            f"https://cdn.caveduck.io/charim-1920x/{UUID}"])
            self.assertEqual(len(srv.seen), 3)  # 첫 성공에서 멈춤
            ok = [c for c in data[0]["candidates"] if c.get("ok")]
            self.assertEqual(ok[0]["result"]["summaries"][0]["type"], "NovelAI")
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
