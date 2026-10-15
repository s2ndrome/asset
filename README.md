# ZZUN META thief ♡

이미지 링크를 붙여넣으면 **원본 이미지 주소를 찾고**, 그 파일 안에 들어 있는 **AI 생성 메타데이터(프롬프트, 네거티브, 시드, 샘플러 등)** 를 보여주는 정적 웹 도구입니다.
caveduck.io 주소는 전용 규칙으로 원본을 찾고, **티스토리·노션** 주소는 썸네일/프록시 주소 안에 든 원본 주소를 꺼내며, 그 밖의 이미지 주소는 그대로 시도합니다.
빌드 도구 없이 `index.html` + `style.css` + `js/*.js` 만으로 동작하고, GitHub Pages로 배포할 수 있습니다.

> ⚠️ **먼저 알아둘 점**: CDN에서 변환된 이미지(`charim-standard`, `charim-160x160`, `cdn-cgi/image/...f=auto` 리사이즈 등)는
> 다시 인코딩된 파일이라 **메타데이터가 지워져 있을 가능성이 높습니다.** 이 도구는 그래서 업로드 원본으로 추정되는
> `charim/<uuid>` 를 가장 먼저 시도합니다. 원본에도 정보가 없다면 업로드 단계에서 이미 제거된 것입니다.

## 목차
- [사용법 (웹)](#사용법-웹)
- [URL 변환 규칙](#url-변환-규칙)
- [읽을 수 있는 메타데이터](#읽을-수-있는-메타데이터)
- [CORS 한계](#cors-한계)
- [프록시 설정 (Cloudflare Workers)](#프록시-설정-cloudflare-workers)
- [CLI 사용법](#cli-사용법)
- [배포 (GitHub Pages)](#배포-github-pages)
- [개발 · 테스트](#개발--테스트)

## 사용법 (웹)

화면 구성: 왼쪽 **Result** 에 결과 카드가 쌓이고, 오른쪽 패널에서 입력합니다(모바일에서는 패널이 위). 상단에서 자동/라이트/다크 테마를 고를 수 있습니다.

1. 입력 칸에 caveduck 이미지 주소를 붙여넣고 **원본 찾기 · 분석** (Ctrl/⌘+Enter).
   - 여러 줄을 한 번에 넣으면 줄마다 따로 처리합니다. 같은 UUID는 한 번만 처리합니다.
   - 주소 앞뒤에 딸려 온 `|`, `'`, `"`, 괄호, 공백, 마크다운 `![](...)` 등은 자동으로 정리합니다.
2. **페이지 HTML 소스 전체**를 붙여넣으면 자동으로 *HTML 소스 모드*가 됩니다.
   - 안에 있는 `cdn.caveduck.io` 이미지 주소(JSON 이스케이프된 `https:\/\/...` 포함)와 `charim-*/<uuid>` 경로를 모두 뽑아 UUID 단위로 묶고,
     근처에 `imageNameInternal` 같은 이미지 설명 필드가 있으면 같이 보여줍니다.
   - 항목별 **원본 찾기** 또는 **모두 분석**.
3. 이미지 **파일을 끌어다 놓기 / 선택 / 붙여넣기(Ctrl+V)** 로도 분석할 수 있습니다(항상 가능, 파일은 브라우저 밖으로 나가지 않음).
4. 결과 화면
   - 후보 주소별 상태: `✔ 200`(파일 읽기 성공) / `✖ HTTP 404` / `⚠ 읽기 차단(CORS)`, 그리고 `<img>`로 로드되는지(존재 여부) 별도 표시
   - 원본 미리보기, 형식·해상도·파일 크기
   - 생성기별 요약(프롬프트/네거티브/캐릭터 프롬프트/설정 표) + 원본 메타데이터 항목 전체(긴 JSON은 접고 펼치기)
   - 미리보기 아래 **원본 이미지 저장**: 받은 파일을 바이트 그대로 저장하므로 생성 정보(메타데이터)가 함께 들어 있습니다
   - 결과 위 **생성 정보 있는 원본 N개 ZIP 저장**: 생성 정보가 있는 원본만 골라 압축 없이(바이트 그대로) 한 파일로 묶어 저장
     (설정에서 **ZIP에 생성 정보 없는 원본도 모두 넣기**를 켜면 받은 원본 전부를 묶고, 정보 없는 파일 이름 앞에 `no-meta_` 를 붙입니다)
   - 모든 텍스트에 **복사** 버튼, **결과 JSON 다운로드**
   - 정보가 없으면 “**이 파일에는 생성 정보가 없음** (업로드·변환 과정에서 제거됐을 가능성)”이라고 표시
5. `index.html?url=<주소>` 로 열면 바로 분석합니다.

설정(오른쪽 패널 **설정**, 상단 **설정** 버튼)
- **프록시 주소**: CORS 우회용. 브라우저 `localStorage` 에 저장됩니다.
- 직접 요청 건너뛰고 프록시만 사용 / 모든 후보 검사(첫 성공에서 멈추지 않음) / 픽셀에 숨긴 정보(stealth pnginfo) 검사 / ZIP에 생성 정보 없는 원본도 모두 넣기

## 다른 사이트 주소

| 사이트 | 입력 예 | 먼저 시도하는 원본 |
|---|---|---|
| 티스토리 | `https://img1.daumcdn.net/thumb/R1280x0/?scode=mtistory2&fname=https%3A%2F%2Fblog.kakaocdn.net%2Fdn%2F…%2Fimg.png` | `fname` 안의 `https://blog.kakaocdn.net/dn/…/img.png` |
| 티스토리(옛 cfile) | `https://t1.daumcdn.net/cfile/tistory/<id>` | `…/cfile/tistory/<id>?original` |
| 노션 | `https://www.notion.so/image/<인코딩된 원본>?table=block&id=…&width=…` | 안에 든 S3 원본 → `width` 를 뗀 노션 주소 → 입력 주소 |
| 그 밖 | 아무 `https://` 이미지 주소 | Cloudflare `/cdn-cgi/image/<옵션>/` 이 있으면 뗀 주소, 없으면 입력 주소 그대로 |

- 페이지 HTML 소스를 붙여넣으면 `<img src>`·`data-src`·`srcset`(가장 큰 것)·`og:image` 이미지도 모두 뽑습니다(`alt` 를 설명으로 표시).
- 메타데이터가 남아 있는지는 사이트가 **원본 파일을 그대로 주는지**에 달려 있습니다. 썸네일·리사이즈본은 대개 지워져 있습니다.
- 노션 S3 원본은 서명(만료 시간)이 필요한 경우가 많아 실패할 수 있습니다. 그럴 땐 노션 주소나, 이미지를 저장해 파일로 넣으세요.
- 브라우저에서 직접 읽기가 막히면(CORS) 프록시가 필요합니다. 기본 Worker 는 caveduck·티스토리(카카오)·노션 이미지 호스트만 허용합니다(`EXTRA_HOSTS` 로 추가).

## URL 변환 규칙 (caveduck)

입력 예:
```
https://cdn.caveduck.io/cdn-cgi/image/anim=true,dpr=2,f=auto,w=800/charim-standard/a1723c53-fe6f-4a8f-b058-13b84e0781ad?v=47d447
```
1. `cdn-cgi/image/<옵션>/` (Cloudflare 이미지 리사이즈) 제거
2. 경로 종류(`charim`, `charim-1920x`, `charim-standard`(640px WebP), `charim-160x160`)와 UUID, `?v=` 추출
3. 후보를 우선순위대로 시도:

| 순서 | 주소 | 설명 |
|---|---|---|
| 1 | `https://cdn.caveduck.io/charim/<uuid>` | 업로드 원본(추정) |
| 2 | `https://cdn.caveduck.io/charim/<uuid>?v=<v>` | 원래 v 값 붙임 |
| 3 | `https://cdn.caveduck.io/charim-1920x/<uuid>` (`?v=` 버전도) | 1920px |
| 4 | `https://cdn.caveduck.io/charim-standard/<uuid>` | 640px WebP |
| 5 | `https://cdn.caveduck.io/charim-160x160/<uuid>` | 썸네일 |

- `?v=` 가 `charim-standard`/`charim-160x160` 같은 변환본에서 온 짧은 해시면 `charim/` 에는 **붙이지 않은 주소를 먼저** 시도합니다.
  입력이 원래 `charim/...?v=` 였다면 v 를 붙인 주소를 먼저 시도합니다.
- 기본은 첫 성공에서 멈춥니다(“모든 후보 검사”를 켜면 전부 받아 비교).

## 읽을 수 있는 메타데이터

파일을 `ArrayBuffer`로 받아 매직 바이트로 형식을 판별하고 순수 JS로 읽습니다(외부 라이브러리 없음).

| 형식 | 읽는 위치 |
|---|---|
| PNG | `tEXt` / `iTXt` / `zTXt` 청크 전부(압축은 `DecompressionStream('deflate')`로 해제), `eXIf`, XMP(iTXt `XML:com.adobe.xmp`) |
| JPEG | EXIF APP1(`UserComment`·`ImageDescription`·`Software`·XP* 등), XMP(확장 XMP 포함), `COM` 세그먼트 |
| WebP | RIFF `EXIF` / `XMP ` 청크, VP8/VP8L/VP8X 해상도 |
| GIF | 코멘트 확장 블록, XMP 애플리케이션 확장 |
| AVIF/HEIF | 형식과 해상도(`ispe`), 찾을 수 있으면 EXIF |
| 공통 | 형식, 해상도, 파일 크기, 알파·애니메이션 여부. 구조로 못 찾은 XMP는 원문 검색으로 보완 |

생성기별 해석
- **Stable Diffusion WebUI(A1111/Forge 등)**: `parameters` → 프롬프트 / `Negative prompt:` / `Steps: …, Sampler: …` 설정 표.
  JPEG·WebP의 EXIF `UserComment`(UNICODE, 빅/리틀 엔디언 자동 판별)에 같은 형식이 있어도 해석
- **NovelAI**: `Description`, `Software`, `Source`, `Comment`(JSON → prompt, uc, steps, scale, seed, sampler, noise_schedule …, V4 캐릭터 프롬프트·위치)
- **ComfyUI**: `prompt`(API 그래프에서 KSampler의 positive/negative를 따라가 텍스트 추출, 시드·스텝·CFG·체크포인트·LoRA), `workflow`(JSON 접고 펼치기)
- **stealth pnginfo**: 텍스트 청크가 없을 때 PNG/WebP 픽셀의 알파(또는 RGB) 최하위 비트에 숨긴 정보(NovelAI·sd-webui-stealth-pnginfo 방식)를 canvas로 검사

## CORS 한계

브라우저는 다른 도메인의 파일 **내용**을 읽으려면 그 서버가 `Access-Control-Allow-Origin` 헤더를 줘야 합니다.
`cdn.caveduck.io` 가 이 헤더를 주지 않으면 GitHub Pages에서 `fetch` 로 파일을 읽을 수 없습니다.

확인 방법:
```sh
curl -sI -H "Origin: https://example.github.io" \
  "https://cdn.caveduck.io/charim/a1723c53-fe6f-4a8f-b058-13b84e0781ad" | grep -i -E "^HTTP|access-control|content-type|cf-"
```
- `access-control-allow-origin: *` (또는 내 Origin)이 보이면 → 웹에서 바로 동작
- 없으면 → 아래 중 하나
  1. 후보 링크를 새 탭에서 열어 저장한 뒤 파일 상자에 **끌어다 놓기** (항상 가능)
  2. **프록시**(아래 Cloudflare Worker) 설정
  3. 로컬 **CLI** 사용 (CORS 제약 없음)

CORS로 막혀도 `<img>` 태그 로드는 가능하므로, 도구는 각 후보가 **존재하는지**(“🖼 img 로드 OK”)와 미리보기는 계속 보여줍니다.
단, 메타데이터는 파일 바이트를 읽어야만 확인할 수 있습니다.

## 프록시 설정 (Cloudflare Workers)

`worker/worker.js` 는 **허용 목록의 이미지 호스트만** 받는 작은 CORS 프록시입니다(caveduck, 티스토리 `*.daumcdn.net`·`*.kakaocdn.net`·`*.tistory.com`, 노션 `notion.so`·`*.notion.site`·노션 S3 버킷). 다른 호스트는 `EXTRA_HOSTS` 환경 변수로 추가합니다.

- 호스트 화이트리스트(위 목록만, 사용자 정보·다른 포트·목록 밖으로의 리다이렉트 거부)
- 파일 크기 제한(`MAX_BYTES`, 기본 25 MiB — `Content-Length` 와 실제 스트림 양쪽에서 검사)
- 허용 Origin 제한(`ALLOWED_ORIGINS`, 기본 `*`)
- `Accept: */*` 고정 — 이미지 최적화가 WebP/AVIF로 바꿔서 주지 않게
- `cf-polished` 등 진단용 헤더를 그대로 넘겨 줌(“Polish로 변환됨” 여부 확인 가능), 1시간 캐시

배포 (무료 플랜 가능):
```sh
npm install -g wrangler        # 또는 npx wrangler ...
cd worker
wrangler login
# 필요하면 wrangler.toml 의 ALLOWED_ORIGINS 를 "https://<아이디>.github.io" 로 바꾼다
wrangler deploy
# → https://caveduck-proxy.<계정>.workers.dev
```
대시보드로 하려면: Cloudflare → Workers & Pages → Create → Worker → `worker.js` 내용을 붙여넣고 Deploy,
Settings → Variables 에서 `ALLOWED_ORIGINS`, `MAX_BYTES` 설정.

웹 UI의 **가져오기 설정 → 프록시 주소**에 `https://caveduck-proxy.<계정>.workers.dev` 를 넣으면
`…workers.dev/?url=<원래주소>` 형태로 요청합니다. 다른 프록시를 쓰려면 `{url}` 자리표시자를 쓸 수 있습니다
(예: `https://my-proxy.example/fetch?target={url}`).

> 공개 프록시는 남이 쓸 수도 있으니 `ALLOWED_ORIGINS` 를 자기 Pages 주소로 좁히는 것을 권장합니다.
> 필요하면 Cloudflare 대시보드의 Rate Limiting 규칙도 추가하세요.

## CLI 사용법

`cli/caveduck_meta.py` — 표준 라이브러리만으로 동작하고, [Pillow](https://pypi.org/project/pillow/)가 있으면 stealth pnginfo 검사와 해상도 보완을 합니다.

```sh
pip install pillow   # 선택
python cli/caveduck_meta.py "https://cdn.caveduck.io/cdn-cgi/image/w=800/charim-standard/<uuid>?v=47d447"
python cli/caveduck_meta.py image.png other.webp           # 로컬 파일
python cli/caveduck_meta.py page.html                       # 저장한 페이지 HTML → 이미지 전부
pbpaste | python cli/caveduck_meta.py -                     # 표준입력(주소 여러 줄 또는 HTML)
```

| 옵션 | 설명 |
|---|---|
| `--all` | 첫 성공에서 멈추지 않고 모든 후보 검사 |
| `--json FILE` | 결과 JSON 저장 (`-` 면 표준출력, 사람용 출력은 stderr로) |
| `--save DIR` | 받은 이미지 파일 저장 |
| `--proxy URL` | 프록시 경유 (`{url}` 자리표시자 지원) |
| `--raw` | 긴 메타데이터도 자르지 않고 출력 |
| `--list-only` | HTML 모드에서 목록만 출력 |
| `--no-stealth` | 픽셀 LSB 검사 생략 |

후보 주소 시도 → 다운로드 → 메타데이터 출력 순서로 동작하며, 하나라도 받으면 종료 코드 0입니다.

## 배포 (GitHub Pages)

빌드 과정 없이 파일 그대로 배포됩니다.

1. 저장소 **Settings → Pages**
2. **Source**: `Deploy from a branch`, **Branch**: `main` / `/ (root)` → Save
3. 잠시 후 `https://s2ndrome.github.io/asset/` 에서 열립니다.

`.github/workflows/tests.yml` 은 배포와 별개로 푸시마다 테스트만 돌립니다.

로컬에서 보기(ES 모듈이라 `file://` 로는 안 되고 서버가 필요):
```sh
python3 -m http.server 8000   # → http://localhost:8000
```

## 개발 · 테스트

```
index.html, style.css      UI
js/url.js                  URL 정리·후보 생성·HTML 추출
js/parser.js               메타데이터 파서 (PNG/JPEG/WebP/GIF/EXIF/XMP/stealth)
js/app.js                  화면 로직
js/zip.js                  원본을 바이트 그대로 묶는 작은 ZIP 작성기
worker/                    Cloudflare Worker 프록시
cli/caveduck_meta.py       Python CLI
tests/gen_fixtures.py      테스트용 PNG(tEXt/iTXt/zTXt)·JPEG(EXIF/XMP/COM)·WebP·GIF·stealth 샘플 생성 (Pillow)
tests/*.test.mjs           node --test (파서, URL, Worker)
tests/test_cli.py          Python 파서 + 가짜 프록시 서버로 후보 순서/다운로드 검증
```
```sh
sh tests/run.sh    # 샘플 생성 → Node 테스트 → Python 테스트
```
