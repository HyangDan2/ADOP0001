# 최종 QA 보고 — Phase 4 (QA-001 · QA-002 · REG-01~18)

프로젝트: HD2Lab 青松館 (Aomatsukan) · 저장소 `HyangDan2/ADOP0001`
기준: Phase 3 머지 커밋 `7b0ae7b`
작성일: 2026-11-23

이 문서는 워크오더 §10의 A~E 형식을 따른다. 컴파일 성공, 테스트 실행 성공, 기능
구현 완료는 서로 다른 상태로 적는다. 실행하지 못한 검증은 SKIP과 사유로 남기고
통과로 세지 않았다.

---

## A. 변경 요약

### A-1. QA-001 — 생성 산출물 독립 검증 (7샘플 × 5프레임워크)

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| Haruhi 생성 매트릭스 | 신뢰성 fixture 2개 샘플 × 4프레임워크 | 내장 샘플 7개 × 5프레임워크 = 35쌍 + Phase 1 신뢰성 fixture 4개 (총 39쌍) |
| 검증 방식 | 디렉터리 탐색 | `.qa-out/manifest.json`이 쌍마다 실행 가능 여부를 기록, 실행 불가 쌍은 `generated-only`로 구분 |
| TypeScript | 프로젝트 2개 typecheck + Vitest | 샘플별 Vitest 3개 + Jest 3개(타입 검사) + 신뢰성 1개 |
| Python | 파일 단위 parse/import | 샘플별 Pytest 실행(계정·비동기) + 신뢰성 15케이스 |
| Go / Java | 단일 디렉터리 | 샘플별 `go test`(2개), `javac`+JUnit(2개) |
| Takane | 5스펙 × 4타깃 | 동일 (Python 5, C11 5, MCU 5, C++17 5) — 컴파일러 이름을 결과에 명시 |

`tools/qa/check-generated.mjs`는 이제 매니페스트를 읽어 언어가 맞는 쌍만 실행하고,
`localhost`가 해석되지 않는 컨테이너에서는 `server.host: 127.0.0.1`로 한 번만
재시도한 뒤 그 사실을 결과에 적는다(조용히 넘기지 않음).

### A-2. QA가 실제로 재현한 결함 3건 (수정 완료)

| 결함 | 재현 | 원인 | 수정 |
| --- | --- | --- | --- |
| Pytest 산출물이 Python 문법 오류 | `pytest/account_service` → `IndentationError: expected an indented block` (첫 `@pytest.mark.skip` 케이스) | 비활성 케이스의 함수 본문이 `# TODO` 주석뿐 — Python에서 주석은 문장이 아니다 | `src/tools/haruhi/emit.ts` `emitPytest`: 본문에 `pytest.skip("사유")`를 출력 |
| `Account()` 생성 시 TypeError | `pytest/async_repository` → `TypeError: Account.__init__() missing 1 required positional argument: 'email'` | `@dataclass`가 `__init__`을 생성하므로 파서는 생성자를 보지 못했고, 클래스를 인자 없이 생성 가능하다고 판단 | `emit.ts`에 `dataclassRequiredFields()` 추가: 필수 필드가 있으면 비생성 가능으로 분류하고 사유에 `construct Account(email: str)`를 남김 |
| 초기화 후에도 열린 문서가 남음 | REG-09: 초기화 직후 Kotoha가 샘플 문서를 그대로 보여 주고 `kotoha-sample` 버튼이 없음(라이브·로컬 공통) | `resetAllDrafts()`가 저장소만 지우고, 마운트된 도구는 메모리의 문서를 디바운스/`pagehide` flush로 다시 저장해 초안을 되살림 | `resetAllDrafts()`가 store epoch를 올리고 이전 epoch의 쓰기를 버림, 앱이 리로드되어 모든 도구가 빈 저장소에서 시작(`src/App.tsx`, `src/lib/drafts.ts`). REG-09가 회귀를 고정 |

두 결함 모두 `npm run qa:generated`로 먼저 재현 → 수정 → 재실행 순서로 처리했고,
`tests/generated-matrix.test.ts`가 회귀를 고정한다. Phase 1 신뢰성 fixture의
15개 Pytest 케이스와 Vitest/Go/JUnit 케이스는 수정 후에도 그대로 통과한다.

### A-3. QA-002 — 품질 게이트

- `.github/workflows/deploy.yml`은 `tsc --noEmit` → `npm test` → `npm run build`로
  배포를 막고, `deploy`는 `build`에 의존한다. 이 동작은 건드리지 않았다.
- 워크오더가 요구한 8단계 게이트(`npm run qa:generated`, Playwright 포함)는
  `.github/workflows/`에 쓸 수 없다. 이 설치의 GitHub App 토큰에 `workflows`
  권한이 없어 GitHub이 푸시를 거부한다:
  `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`.
  우회하지 않았고, 정의 전문을 `docs/ci-workflow.yml`에 보관했다. 저장소 소유자가
  이 파일을 워크플로에 복사하면 8단계 게이트가 켜진다.
- 반응형/테마 최종 확인: 320px·390px·1440px × 다크/라이트 × 6개 도구, 콘솔·페이지
  오류 0건 (`tests/e2e/phase4.spec.ts`).

### A-4. 변경 파일

| 파일 | 변경 |
| --- | --- |
| `src/tools/haruhi/emit.ts` | Pytest skip 본문, dataclass 필수 필드 판정 |
| `src/App.tsx`, `src/lib/drafts.ts` | 초기화가 저장소와 메모리 상태를 함께 끊도록(epoch + 리로드) |
| `tests/qa/artifacts.test.ts` | 7×5 매트릭스 + fixture 4개 + `manifest.json` |
| `tools/qa/check-generated.mjs` | 매니페스트 기반 실행, Vitest localhost 재시도, Jest 타입 검사, 리포트 JSON |
| `tests/generated-matrix.test.ts` | QA-001 구조 불변식(영문 산출물, 중복 테스트명, 더미 assertion, skip 본문, dataclass) |
| `tests/reg-matrix.test.ts` | REG-01~18이 이름 있는 테스트와 `docs/QA.md`에 계속 연결돼 있는지 검사 |
| `tests/e2e/phase4.spec.ts` | REG-18, QA-002 게이트 정의/반응형·테마·오류 0건, 최종 스크린샷 |
| `tests/e2e/phase3.spec.ts` | REG-04/05 제목 분리, REG-11이 `zig cc`/`zig c++`도 사용 |
| `docs/QA.md`, `docs/ci-workflow.yml`, `README.md` | QA 단계·매트릭스·도구체인·게이트 정의 문서화 |

### A-5. 이전 동작과 수정 후 동작 차이

- 이전: Haruhi가 비활성 Pytest 케이스를 주석 본문으로 출력 → 그 파일을 Pytest에
  넣으면 모듈 전체가 수집 단계에서 실패.
  이후: `pytest.skip("사유")`를 출력 → 해당 케이스만 skip되고 나머지 케이스가 실행.
- 이전: `@dataclass` 클래스의 메서드 케이스가 `Account()`를 호출 → 실행 시 TypeError.
  이후: 필수 필드를 사유에 적은 skip 케이스로 출력.
- 이전: 메뉴의 초기화가 저장된 초안만 지우고, 열려 있던 문서는 디바운스/언로드 저장으로
  되살아남 → 이후: 초기화가 저장소와 메모리 상태를 함께 끊고 모든 도구가 빈 상태로 시작.
- UI 문구와 저장 데이터 형식은 바뀌지 않았다.

---

## B. 테스트 결과 (2026-11-23, Phase 4 최종 실행)

| 항목 | 전체 | 성공 | 실패 | 제외(SKIP) |
| --- | --- | --- | --- | --- |
| TypeScript 검사 (`npx tsc --noEmit`) | 1 | 1 | 0 | 0 |
| Vitest (`npm test`, 19개 파일) | 191 | 191 | 0 | 0 |
| Playwright (`npm run test:e2e`, 4개 spec) | 36 | 36 | 0 | 0 |
| Haruhi 생성 코드 (매트릭스 35쌍 + fixture 4개) | 39 | 39 생성 · 14 실행 | 0 | 25 (언어 불일치 쌍, `generated-only`) |
| ├ Vitest 실행 | 4 | 4 | 0 | 0 |
| ├ Pytest 실행 | 3 | 3 | 0 | 0 |
| ├ Go test 실행 | 2 | 2 | 0 | 0 |
| ├ JUnit 5 실행 | 2 | 2 | 0 | 0 |
| └ Jest 실행 | 3 | 0 | 0 | 3 (jest 미설치, 타입 검사만) |
| Takane 컴파일 (5스펙 × 4타깃) | 20 | 20 | 0 | 0 |
| ├ Python parse+import | 5 | 5 | 0 | 0 |
| ├ C11 (`zig cc`) | 5 | 5 | 0 | 0 |
| ├ MCU C11 (`zig cc`) | 5 | 5 | 0 | 0 |
| └ C++17 (`zig c++`) | 5 | 5 | 0 | 0 |
| Kotoha 문서 QA (phase2 E2E, DOCX 6 fixture) | 7 | 7 | 0 | 0 |
| 전체 회귀 테스트 (REG-01~18) | 18 | 18 | 0 | 0 |

`npm run qa:generated` 최종 요약: **PASS 61 · FAIL 0 · SKIP 3** (matrix 39쌍,
실행 14쌍, generated-only 25쌍). SKIP 3건은 모두 Jest 미설치 사유다.

---

## C. 보존 및 호환성

- **기존 UI 변경 사항**: 없음. 6개 도구, 일본어 UI 문구, 테마, 내비게이션 모두 유지.
  Phase 4는 생성기 내부와 테스트/문서만 바꿨다.
- **기존 저장 데이터 호환성**: 초안·Few-shot 저장 형식과 버전/마이그레이션 변경 없음
  (`tests/drafts.test.ts`, `tests/fewshot.test.ts` 통과).
- **기존 출력 파일 형식 호환성**: export 파일 이름·형식·DOCX 구조 변경 없음.
  Phase 2의 `kotoha-integrity` 테스트 6종이 계속 통과.
- **원본 DOCX 보존 테스트**: phase2 E2E 7건 통과 — 표준 보고서(머리글/바닥글),
  병합 표(경고 후 보존), JPEG/PNG 종횡비, 다단계 목록 번호, 다중 섹션, 특수 OOXML,
  대용량 거부 시 열린 문서 유지.

---

## D. 잔여 이슈

| # | 이슈 | 재현 조건 | 심각도 | 사용자 영향 | 후속 처리 |
| --- | --- | --- | --- | --- | --- |
| D-1 | 워크플로 파일을 푸시할 수 없음 | `.github/workflows/*` 변경 푸시 | 중 | 라이브 게이트가 `qa:generated`·E2E를 아직 강제하지 않음 | `docs/ci-workflow.yml`을 소유자가 복사(웹 편집기 가능). 토큰에 `workflows` 권한을 주는 것도 방법 |
| D-2 | Jest 산출물 실행 검증 없음 | `npm run qa:generated` | 하 | 없는 기능 아님 — 테스트 생성기는 Jest 코드를 만들지만 이 환경에 jest가 없음 | CI에 `jest`·`@jest/globals` devDependency 추가 시 실행 단계가 켜짐 |
| D-3 | JUnit 샘플 케이스가 전부 `@Disabled` | `InvoiceService` 등 반환형을 단정할 수 없는 케이스 | 하 | 생성된 테스트가 "실행 가능"으로 보이지 않음(의도) | 반환형 단정 확장은 별도 과제 |
| D-4 | 실행 커버리지 미측정 | Haruhi 화면 | 하 | 화면에 `N/A`로 표시(정적 매핑률과 구분) | 실행 커버리지 수집은 별도 설계 필요 |
| D-5 | 컨테이너에서 `localhost` 미해석 | Vitest 실행 | 하(환경) | 없음 — QA 러너가 127.0.0.1로 재시도하고 기록 | CI에는 해당 없음 |
| D-6 | 정적 분석은 휴리스틱 | 비정형 문법(데코레이터·매크로 등) | 중 | 일부 함수/분기 누락 가능 | ANA-001 범위 내 점진 개선 과제 |

---

## E. 증빙 자료

- PR: #5 `phase4/qa-gate` → `main` (squash merge). PR 본문에 게이트 순서와 결과 표를 첨부.
- 커밋: 이 PR의 squash merge 커밋과 아래 파일 목록(§A-4).
- 테스트 로그: `npm test` 191/191, `npm run qa:generated` PASS 61·FAIL 0·SKIP 3,
  Playwright 36/36 (spec별: app 11, phase2 7, phase3 15, phase4 3).
- 기계 판독 결과: `.qa-out/qa-report.json`, `.qa-out/manifest.json` (CI 업로드 대상).
- 생성 산출물 샘플: `.qa-out/haruhi/{vitest,jest,pytest,junit5,go}/…`,
  `.qa-out/takane/{python,c,cpp,mcu}/…`.
- DOCX 비교: `downloads/adop0001-fixtures/*.docx`와 phase2 E2E 재생성 결과.
- 최종 화면: `downloads/adop0001-phase4/final-pc.png`(1440×900, 다크),
  `downloads/adop0001-phase4/final-mobile.png`(390×844).
- CI 실행: squash merge 후 `Deploy ADOP0001 to GitHub Pages` 워크플로 실행 결과.
