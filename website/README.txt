Omniweave (오메) — 공식 홈페이지 (정적 사이트)

빌드 도구 없이 이 폴더 그대로 올리면 됩니다. PHP·DB가 필요 없고, 외부 CDN·추적·분석 스크립트도 없습니다.
FTP 호스팅과 GitHub Pages 어느 쪽이든 같은 파일을 씁니다.
한국어(/)·영어(/en/)·일본어(/ja/)·중국어 간체(/zh/) 4개 언어 페이지가 있습니다. 아래 [다국어] 참고.


[파일 설명]
index.html            랜딩 페이지 (히어로, 문제 정의, 6개 모듈, Loom 엔진, .omw, FAQ, 오픈소스, 이름 이야기)
download.html         다운로드 페이지 (OS 자동 감지 추천, 플랫폼별 파일, 체크섬, SmartScreen·업데이트 안내, 요구사항)
                      SNS·블로그·README에는 이 주소(…/download.html)를 올리세요. 버전이 바뀌어도 주소는 그대로입니다.
config.json           버전·다운로드 주소·공개 여부. 대부분의 운영 변경은 이 파일만 고쳐서 다시 올리면 됩니다.
404.html              없는 주소로 들어왔을 때 보이는 페이지
.htaccess             (Apache 호스팅용) 목록 숨김, 404, 압축, 캐시, 보안 헤더 — 숨김 파일이니 꼭 함께 올리세요
robots.txt            검색엔진 안내
site.webmanifest      홈 화면 아이콘 정보
favicon.ico           브라우저 탭 아이콘 (16~256px, 프로젝트 assets/app.ico와 동일)
favicon-32.png, apple-touch-icon.png
assets/css/site.css   공통 스타일 (앱과 같은 색 토큰, 다크 기본 + 라이트 모드)
assets/js/site.js     config.json 반영, OS 감지, 복사 버튼, 탭
assets/js/loom.js     Loom 엔진 섹션의 인터랙티브 그림 (index.html 전용)
assets/fonts/         Pretendard Regular·SemiBold·Bold (SIL OFL, 자체 호스팅)
assets/img/           로고, 아이콘, og-image.png(공유 미리보기 1200×630)
en/ ja/ zh/           언어별 index.html·download.html (생성 결과)
assets/js/lang.js     첫 방문 언어 자동 선택, 언어 메뉴 동작
README.txt            이 안내 (.htaccess가 외부 접근을 막습니다)

  ── 아래는 다국어 페이지를 만드는 "원본"입니다. 서버에 올리지 않아도 됩니다(올려도 .htaccess가 막습니다). ──
_templates/           index.html·download.html 템플릿 ({{키}} 자리에 번역이 들어감)
i18n/ko.json en.json ja.json zh.json   번역 원문 (모든 문구는 여기서만 고칩니다)
build-i18n.mjs        템플릿 + 번역 → 언어별 HTML 생성 (Node 18+, 새 패키지 없음)


[FTP로 올리기]
1. 이 website 폴더 "안의" 파일·폴더를 전부 웹 루트에 올립니다. (호스팅마다 public_html, www, html 등)
   .htaccess 같은 숨김 파일도 올라가도록 FTP 프로그램의 "숨김 파일 표시"를 켜 두세요.
2. 브라우저에서 https://도메인/ 과 https://도메인/download.html 을 열어 확인합니다.
3. 하위 폴더(예: https://도메인/omniweave/)에 올렸다면 .htaccess의
       ErrorDocument 404 /404.html   →   ErrorDocument 404 /omniweave/404.html
   로 바꿔 주세요. 나머지 경로는 모두 상대 경로라 그대로 동작합니다.
4. _templates/, i18n/, build-i18n.mjs, README.txt 는 올리지 않아도 됩니다.
5. 이전 사이트 파일이 남아 있다면 겹치지 않는지 확인합니다. (이 사이트에는 admin·api·PHP 파일이 없습니다)
※ config.json은 서버가 고치지 않으므로 쓰기 권한(666)이 필요 없습니다. 기본 권한(644) 그대로 두세요.


[GitHub Pages로 올리기]
저장소 루트의 .github/workflows/pages.yml 이 website/ 폴더를 Pages로 배포합니다.
1. GitHub 저장소 Settings → Pages → Build and deployment → Source: "GitHub Actions" 선택.
2. main 브랜치에 website/ 변경을 push하면 자동 배포됩니다. Actions 탭 → Pages → Run workflow 로 수동 실행도 됩니다.
3. 주소: https://wind2sp.github.io/omniweave/ (사용자 지정 도메인을 쓰면 Settings → Pages → Custom domain)
※ 저장소가 비공개(private)인 동안에는 GitHub Pages가 유료 플랜(Pro/Team/Enterprise)에서만 됩니다.
   무료 계정이면 저장소를 공개한 뒤에 Pages를 켜세요. 그 전에는 FTP로 운영하면 됩니다.
※ GitHub Pages는 .htaccess를 읽지 않습니다(캐시·보안 헤더는 GitHub 기본값). 사이트 동작에는 영향이 없습니다.


[config.json 고치는 법]  (메모장으로 열어 값만 바꾸고 저장 → 이 파일만 다시 업로드)
  "siteUrl"         사이트 전체 주소. 예) "https://omniweave.example/"  (비워 두면 상대 경로)
                    채우면 build-i18n.mjs가 hreflang·canonical·og:url·og:image를 전체 주소로 만듭니다.
                    → 바꾼 뒤에는 node build-i18n.mjs 를 실행하고 HTML을 다시 올리세요.
  "copyright"       푸터 저작권 줄. 기본 "© 2026 NINEROW partners Co., Ltd. and Omniweave contributors · GPL-3.0-or-later" (모든 언어 페이지에 같은 문구)
  "version"         최신 버전 번호. 예) "0.1.0" → "0.1.1"
                    파일 이름·다운로드 주소의 {version} 자리에 자동으로 들어갑니다.
  "released"        false = 모든 다운로드 버튼이 "곧 공개"로 표시 (지금 상태)
                    true  = GitHub Releases의 실제 파일로 연결
                    → 릴리스를 "게시(Publish)"한 다음에 true로 바꾸세요. 초안(Draft) 상태에서는 링크가 404입니다.
  "releaseDate"     공개일. 예) "2026-12-01" (비워 두면 표시 안 함)
  "repoPublic"      false = GitHub 저장소 링크를 "공개 준비 중"으로 표시 / true = 저장소·이슈·기여 안내 링크 활성화
  "repoUrl"         저장소 주소
  "releasePageUrl"  "모든 릴리스" 링크 (released와 repoPublic이 모두 true일 때 표시)
  "demoPublic"      false = "설치 없이 지금 써 보기"(브라우저 데모) 버튼을 숨김 (지금 상태)
                    true  = 버튼 표시. GitHub Pages에 웹 앱이 /app/ 으로 실제 배포된 것을 확인한 뒤 켜세요.
  "demoUrl"         데모 주소. 기본 "app/?demo" (사이트 기준 상대 경로, https://로 시작하면 그 주소 그대로)
  "downloadBase"    파일을 받는 기본 주소. {version}이 버전으로 바뀝니다.
                    기본값: https://github.com/wind2sp/omniweave/releases/download/v{version}/
  "files"           각 파일 이름. enabled:false 로 두면 그 파일만 "준비 중"으로 표시됩니다.
                    (예: 맥 빌드가 실패한 릴리스면 macDmg의 enabled를 false로)
                    name에 https://로 시작하는 전체 주소를 넣으면 downloadBase 대신 그 주소를 씁니다.
  "autoUpdate"      설치본에 자동 업데이트가 들어간 릴리스부터 true (다운로드 페이지 안내 문구가 바뀝니다)
  "codeSigned"      설치 파일에 코드 서명을 하게 되면 true (SmartScreen 안내 문구가 바뀝니다)
  "screenshots.hero" 랜딩 첫 화면 스크린샷 경로. 예) "assets/img/hero.webp"
                    비워 두면 "스크린샷 준비 중" 그림이 보입니다. 16:9 비율, 가로 1600~2200px을 권장합니다.
※ 큰따옴표·쉼표가 하나라도 틀리면 페이지가 기본값("곧 공개")으로 돌아갑니다.
   올리기 전에 로컬에서 확인하세요:
       python -m json.tool config.json
※ config.json을 못 읽는 경우(파일을 더블클릭해 열었을 때 등)에도 페이지는 "곧 공개" 상태로 정상 표시됩니다.


[스크린샷 넣기]
1. 실제 앱 캡처(예: 저장소의 docs/images/hero.png)를 assets/img/hero.png 또는 .webp로 복사합니다.
   (webp로 바꾸면 용량이 크게 줄어듭니다. Pillow가 있으면:
    python -c "from PIL import Image; Image.open('hero.png').save('hero.webp', quality=86, method=6)")
2. config.json의 "screenshots": { "hero": "assets/img/hero.webp" } 로 적고 함께 올립니다.


[공유 미리보기(og:image)]
siteUrl이 비어 있으면 og:image가 상대 경로입니다. 카카오톡·페이스북 등 일부 서비스는 전체 주소만 읽으니,
도메인이 정해지면 config.json의 "siteUrl"을 채우고 node build-i18n.mjs 를 실행하세요.
og:title·description은 언어별로 다르고, 그림은 모든 언어가 같은 assets/img/og-image.png(한국어 문구)를 씁니다.
그림 원본은 저장소 assets/brand/og-image.png (assets/brand/make_brand.py로 생성)입니다.


[다국어]
- 언어별 주소: /(한국어, 기본) · /en/ · /ja/ · /zh/ — 각각 index.html, download.html.
  각 페이지에 <html lang>, hreflang 링크(서로 연결 + x-default=루트), 언어별 og:title/description이 들어 있습니다.
- 자동 선택: 루트(/ 또는 /download.html)에 "처음" 온 방문자만 브라우저 언어(navigator.languages)를 보고
  /en/ /ja/ /zh/ 로 한 번 보냅니다. 한국어면 그대로, 지원하지 않는 언어면 영어.
  헤더의 언어 메뉴(KO/EN/日本語/中文)로 고르면 브라우저(localStorage)에 기억하고, 그 뒤로는 자동으로 옮기지 않습니다.
  검색엔진·미리보기 봇과 사이트 안에서 이동해 온 경우에는 옮기지 않습니다.
- 정적 사이트라 서버 없이는 접속 국가(IP)를 알 수 없어 "브라우저 언어"로 고릅니다.
  IP 기반 국가 감지가 꼭 필요하면 Cloudflare 등 CDN의 국가 헤더(예: CF-IPCountry)나 서버 측 리다이렉트
  (Apache mod_geoip/mod_maxminddb, Nginx geoip 모듈 등)로 가능합니다. 이 경우에도 언어 메뉴로 바꿀 수 있게 두세요.
- 문구 고치기:
    1) i18n/ko.json (그리고 en/ja/zh.json의 같은 키)을 고칩니다. 모든 언어에 같은 키가 있어야 하며,
       하나라도 빠지면 생성 스크립트가 어느 키인지 알려 주고 멈춥니다.
    2) website 폴더에서  node build-i18n.mjs   (확인만:  node build-i18n.mjs --check)
    3) 바뀐 HTML(루트·en·ja·zh)을 올립니다.
  생성된 HTML을 직접 고치면 다음 생성 때 덮어써집니다. 레이아웃은 _templates/*.html 에서 고칩니다.
  GitHub Pages 워크플로는 --check로 HTML이 번역과 맞는지 검사하고, 다르면 배포하지 않습니다.
- 앱 UI는 한국어·영어·일본어·중국어(간체) 4개 언어를 지원합니다(설치할 때 고르고, 환경 설정에서 바꿈). 홈페이지 FAQ·로드맵에도 그렇게 적어 두었습니다.


[CSS·JS를 고쳤을 때]
.htaccess가 CSS·JS를 7일 캐시하므로, 고친 뒤에는 build-i18n.mjs 맨 위의 ASSET_VERSION 숫자를 올리고
node build-i18n.mjs 를 실행하세요(모든 언어 HTML의 ?v= 가 함께 바뀝니다). 404.html의 ?v= 는 손으로 맞춥니다.
HTML과 config.json은 캐시하지 않으므로 올리는 즉시 반영됩니다.


[로컬에서 미리 보기]
  python -m http.server 5310 --directory website
  → http://localhost:5310/
(파일을 더블클릭해서 열어도 보이지만, 그때는 config.json을 읽지 못해 기본값으로 보입니다)


[원칙]
- 측정·구현되지 않은 기능이나 수치는 쓰지 않습니다. 숫자는 저장소 README "측정값" 표의 실측값만 씁니다.
- 외부 CDN·글꼴 서비스·분석 도구를 넣지 않습니다(.htaccess의 Content-Security-Policy가 외부 파일을 막습니다).
- 상표 고지·클린룸 원칙·GPL-3.0-or-later 문구는 푸터에 유지합니다.
