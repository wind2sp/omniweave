# Omniweave에 기여하기 / Contributing

관심 가져 주셔서 고맙습니다. 한국어·영어 어느 쪽으로 이슈와 PR을 쓰셔도 됩니다.
*Issues and PRs in English or Korean are both welcome.*

## 가장 도움이 되는 기여

1. **깨지는 실제 파일 제보.** DOCX·HWPX·PDF를 열었을 때 내용이 빠지거나 모양이 크게 다른 사례. 민감한 내용은 지우고, 문제가 재현되는 가장 작은 파일을 첨부해 주세요.
2. **형식 매핑 확장.** [docs/CONCEPT.md](docs/CONCEPT.md)의 매핑 표에서 "부분/없음"인 항목(표, 각주, 그림 등).
3. **Loom 성능·정확성.** [docs/LOOM.md](docs/LOOM.md)의 "한계" 표 항목, 벤치마크 추가.
4. **문서·번역.** README, 영어 UI 문자열.

## 개발 환경

```bash
npm i
npm run dev          # http://localhost:5199
npm test             # Vitest 단위 테스트
npx tsc --noEmit     # 타입 검사 (CI와 같음)
npm run bench        # Loom 벤치마크
npm run tauri dev    # 데스크톱 (Rust 툴체인 + Tauri 2 사전 요구사항 필요)
```

## 코드 구조

| 폴더 | 내용 |
|---|---|
| `src/core/` | 씬 그래프 타입, Loom(해시·키·dehydrate/hydrate), 상태·히스토리, 텍스트 조판, 벡터, 애니메이션 |
| `src/render/` | Weave Cache 렌더러, 노드 그리기, 브러시 |
| `src/io/` | `.omw` 패키저, 저널, DOCX/HWPX, PDF, 내보내기, 플랫폼(Tauri/웹) 파일 입출력 |
| `src/ui/` | React UI (캔버스, 리본, 도크, 슬라이드쇼, 단축키) |
| `src-tauri/` | Tauri 2 데스크톱 셸 |
| `tests/`, `bench/` | 단위 테스트, 벤치마크 |

## 지켜 주실 원칙

- **불변성.** 문서는 `useStore().commit` / 제스처 API로만 바꿉니다. 노드 객체를 제자리에서 바꾸면 Loom의 해시 메모와 화면 캐시가 틀어집니다.
- **렌더는 키의 함수.** 그림 결과에 영향을 주는 새 상태를 추가하면 `weaveKey`/`regionKey`에 반영해야 합니다([LOOM.md 2.3](docs/LOOM.md#23-왜-오래된-픽셀이-구조적으로-불가능한가)).
- **테스트.** 동작을 바꾸는 PR에는 테스트를 붙여 주세요. 형식 가져오기/내보내기는 왕복 테스트를 권장합니다(`tests/office.test.ts` 참고).
- **정직한 문서.** README에 기능을 추가할 때는 구현된 것만 적고, 성능 수치는 `bench/`로 재현 가능한 것만 적습니다.

## 클린룸 원칙 (중요)

- 타사 상용 프로그램의 바이너리를 **디스어셈블·디컴파일·리버스 엔지니어링한 결과를 기여하지 마세요.**
- 근거는 공개 표준과 공개 문서입니다: ISO 32000(PDF), ECMA-376(Office Open XML), KS X 6101(HWPX/OWPML) 등. PR 설명에 참고한 문서를 적어 주세요.
- 다른 프로젝트의 코드를 옮겨 올 때는 라이선스가 GPL-3.0-or-later와 호환되는지 확인하고(MIT·BSD·Apache-2.0·ISC·MPL-2.0 등은 호환, GPL-2.0-only·독점 라이선스는 불가) 출처를 남겨 주세요. 새 의존성을 추가하면 `npm run notices`로 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 다시 만들어 주세요.
- 상표(회사명·제품명)는 형식 호환성을 설명할 때만 쓰고, 로고·아이콘·UI를 흉내 내지 않습니다.

## 커밋과 PR

- 작은 단위로 나눠 주세요. 커밋 메시지는 한국어·영어 모두 좋습니다. 첫 줄에 무엇을 바꿨는지, 본문에 왜 바꿨는지.
- PR 템플릿의 체크리스트(테스트, 타입 검사, 문서 반영)를 채워 주세요.
- UI 변경은 스크린샷이나 짧은 GIF가 있으면 리뷰가 빨라집니다.

## 행동 원칙

서로 존중해 주세요. 사람이 아니라 코드와 아이디어를 이야기합니다. 괴롭힘이나 차별은 허용하지 않습니다.

## 라이선스

기여하신 코드는 저장소와 같은 [GNU GPL 3판 또는 그 이후 판(GPL-3.0-or-later)](LICENSE)으로 배포되는 데 동의한 것으로 봅니다.

커밋에는 [DCO(Developer Certificate of Origin)](https://developercertificate.org/) 서명을 권장합니다. `git commit -s`로 커밋하면 메시지 끝에 `Signed-off-by: 이름 <이메일>` 줄이 붙으며, 기여한 코드를 이 라이선스로 낼 권리가 있음을 확인하는 뜻입니다.
