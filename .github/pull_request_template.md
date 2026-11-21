## 무엇을 바꿨나요? / What does this change?

## 왜? / Why?
<!-- 관련 이슈 / Related issue: #  -->

## 확인 / Checklist
- [ ] `npm test` 통과 / passes
- [ ] `npx tsc --noEmit` 통과 / passes
- [ ] 동작 변경에 테스트를 추가했습니다 / added tests for behaviour changes
- [ ] 문서 상태를 immer/스토어 API로만 바꿉니다 (제자리 변경 없음) / documents are changed only through the store (no in-place mutation)
- [ ] 렌더 결과에 영향을 주는 새 상태는 `weaveKey`에 반영했습니다 (해당 시) / new render-affecting state is part of `weaveKey` (if applicable)
- [ ] README·docs를 갱신했습니다 (해당 시). 성능 수치는 `bench/`로 재현 가능한 것만 적었습니다 / docs updated; performance numbers are reproducible via `bench/`

## 클린룸 / Clean room
- [ ] 타사 바이너리의 리버스 엔지니어링 결과를 포함하지 않습니다 / contains no results of reverse-engineering third-party binaries
- 참고한 공개 사양·문서 / public specs or docs consulted:

## 스크린샷 / Screenshots (UI 변경 시 / for UI changes)
