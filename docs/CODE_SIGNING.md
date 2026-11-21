# 코드 서명 (Windows)

서명하지 않은 설치본은 Windows가 "Windows의 PC 보호(SmartScreen)" 경고를 띄워 다운로드·설치 전환이 크게 떨어집니다.
오메는 서명 준비를 모두 마쳐 두었고, **인증서만 연결하면** 로컬·CI 빌드 모두 자동으로 서명됩니다.

## 이미 되어 있는 것

- `src-tauri/tauri.conf.json` → `bundle.windows.signCommand`가 빌드되는 모든 실행 파일(앱 exe, 설치본)에 대해
  `scripts/sign-windows.ps1`을 호출합니다(SHA-256, RFC 3161 타임스탬프, 서명 후 `signtool verify`로 확인, 3회 재시도).
- 서명 설정은 **환경 변수로만** 받습니다(저장소에 비밀값 없음). 아무것도 설정하지 않으면 서명 없이 빌드하고 그 사실만 출력합니다.
- `.github/workflows/release.yml`이 저장소 Secrets의 서명 설정을 빌드에 넘깁니다.
- 앱 업데이트 파일은 이와 별도로 **업데이트 서명 키**(`~/.tauri/omniweave.key`)로 항상 서명·검증됩니다(코드 서명이 없어도 업데이트 위변조는 막힘).

## 인증서 선택지

| 방법 | 비용(대략) | SmartScreen 경고 | 비고 |
|---|---|---|---|
| **SignPath Foundation** (오픈소스 무료 서명) | 무료 | 평판이 쌓이면 사라짐 | 저장소 **공개 후** 신청·심사. CI 연동형(서명은 SignPath 서비스에서) |
| OV 코드 서명 인증서 (Sectigo·SSL.com·DigiCert 등) | 연 수십만 원대 | 다운로드가 쌓이며 점차 사라짐 | 2023년부터 개인키는 하드웨어 토큰 또는 클라우드 HSM에만 보관 → CI는 클라우드 서명(예: SSL.com eSigner) 필요 |
| EV 코드 서명 인증서 | OV보다 비쌈 | 2024년 이후 OV와 같은 평판 방식으로 바뀜 | 법인 서류 심사 |
| Azure Trusted Signing | 월 구독 | 평판 방식 | 지원 국가·신원 확인 조건이 있음 — 한국 법인 가능 여부를 먼저 확인 |

정확한 가격·조건은 계속 바뀌니 구입 전에 각 판매처에서 확인하세요.

**권장 순서**: 저장소를 공개하면 **SignPath Foundation**에 무료 서명을 신청 → 승인 전까지는 서명 없이 배포하되
다운로드 페이지에 SmartScreen 안내(이미 있음)를 유지. 법인 명의 배포라면 OV 인증서(클라우드 서명형)도 좋은 선택입니다.

## 연결 방법

### 1) 인증서가 이 PC(또는 USB 토큰)에 있을 때 — 로컬 빌드
```powershell
$env:OMW_SIGN_MODE = "thumbprint"
$env:OMW_SIGN_THUMBPRINT = "<인증서 지문 SHA1>"   # certmgr.msc → 개인용 → 인증서 → 자세히 → 지문
npm run release:win
```

### 2) .pfx 파일이 있을 때(구형 방식, 가능하면 비추천)
`OMW_SIGN_MODE=pfx`, `OMW_SIGN_PFX=<경로>`, `OMW_SIGN_PFX_PASSWORD=<암호>` — .pfx는 저장소에 절대 넣지 마세요.

### 3) Azure Trusted Signing
`OMW_SIGN_MODE=trusted`, `OMW_SIGN_DLIB=<Azure.CodeSigning.Dlib.dll 경로>`, `OMW_SIGN_METADATA=<metadata.json 경로>`.

### 4) CI(GitHub Actions)
저장소 Settings → Secrets and variables → Actions에 위 변수(`OMW_SIGN_MODE` 등)를 등록하면 태그 릴리스 빌드가 서명됩니다.
클라우드 HSM 서명 도구(SignPath, eSigner 등)를 쓰면 `release.yml`에 해당 서비스의 공식 Action 단계를 추가합니다.

## 확인
서명된 exe를 마우스 오른쪽 → 속성 → **디지털 서명** 탭에 서명자가 보이면 정상입니다. 명령으로는
`signtool verify /pa /v Omniweave_x.y.z_x64-setup.exe`.
