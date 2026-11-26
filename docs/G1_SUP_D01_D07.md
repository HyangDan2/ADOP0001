# G1 Supervisor Requirements — SUP-D01~D07

- **Status:** REGISTERED — CP02 authorized
- **Issuer:** Technical Supervisor
- **Recipient:** Qoder-00 Engineering Lead
- **Gate G0 baseline:** `04dd2fc0808e199d5baa09b8b290a5dee25dd4a4`
- **CP01 candidate:** `b4532461cb482c7814dd4a701784daa6058bc16f`
- **CP01:** APPROVED WITH IMPLEMENTATION CONDITIONS
- **CP02:** AUTHORIZED
- **Date:** 2026-11-27

This document is the repository-managed registration of the CP02 implementation
order. It does not authorize WO-D05+, Phase 5E/5F work, or a production merge.

---

## SUP-D01 — Artifact Identity

Artifact ID와 Revision ID를 분리한다. Revision은 불변이며 수정 및 명시적 복원은
신규 Revision을 생성한다. Content Digest, Revision Integrity Hash, Source
Identity 및 Parent Revision의 관계를 명확히 관리한다.

기존 EngineContracts 및 artifactRevision.ts를 우선 재사용한다.

## SUP-D02 — Independent Lifecycle

Lifecycle, Validation, Freshness, Persistence, Export History를 독립적으로
관리한다.

검증 중 Revision 변경, Export 이후 수정, 저장 실패, 복원 및 Validator 변경을
처리한다.

도구별 중복 상태 머신 구현을 금지한다.

## SUP-D03 — Capability-driven Validation

Artifact Type Registry 기반 Validator 선택.

Validator ID, Version, Configuration, REQUIRED/OPTIONAL, Execution Status,
Diagnostics 및 검증 대상 Hash를 기록한다.

미실행·미지원 필수 Validator를 PASS로 간주하지 않는다.

구문, 구조, 의미, Compile 검증을 구분한다. 미검증 Debug Export는 정상 Export와
분리한다.

5E Parser 및 5F Toolchain을 선행 구현하지 않는다.

## SUP-D04 — Atomic Persistence

Artifact Content, Revision Metadata 및 Current Pointer의 원자적 저장을 보장한다.

Transaction Abort, Quota, Migration, IndexedDB 실패, 다중 탭 경합,
Reset/Autosave 경합을 검증한다.

Epoch 및 CAS 조건을 Transaction 내부에서 검사한다.

실패 상태와 Memory-only 상태를 명시하며 기존 데이터를 무단 삭제하지 않는다.

API Key, 인증정보 및 Raw Gateway Request의 저장을 금지한다.

## SUP-D05 — Dynamic Configuration

Artifact Type, Export Format, Validator 선택, 검증 정책, 저장 용량, Revision
보존, Artifact 개수, Content 크기 및 검증 자원 상한은 중앙 Configuration 및
Registry에서 관리한다.

환경 및 실제 저장소 사용량을 고려하여 자원을 할당한다.

보안 상한과 검증된 기본값은 중앙 정책으로 유지한다.

## SUP-D06 — Runtime Integration

기존 6개 도구의 실제 실행 결과를 다음 공통 경로에 연결한다.

```text
Local Engine Result
→ Artifact Contract
→ Revision Registration
→ Validator Registry
→ Validation Policy
→ Artifact Repository
→ Existing Export Guard
```

Hybrid AI 제안 적용 경로에도 동일한 Contract 및 Revision 정책을 적용한다.

기존 Local Engine, Output Format, 일본어 UI, 영어 Artifact 및 테마 호환성을
유지한다.

공통 모듈의 존재만으로 Runtime Integration 완료를 주장하지 않는다.

## SUP-D07 — Independent Regression

REG-G1-01~29 및 INV-01~34를 독립적으로 검증한다.

기존 680 Unit Tests 및 70 E2E Tests를 유지한다.

테스트 삭제, 기대값 완화 및 미실행 테스트의 PASS 보고를 금지한다.

Qoder-05는 구현 담당자와 독립적인 기대값 및 검증 자료를 사용한다.

---

## Contract Corrections

| ID | Required correction |
| --- | --- |
| C01 | `commitValidation`의 Transaction 대상 Store에 `revisions`를 포함한다. |
| C02 | `registerExport`에 필요한 `artifacts`/`revisions`/`pointers`/`meta`/`exports`의 일관된 조회 및 쓰기 범위를 정의한다. |
| C03 | Export Byte Hash, Content Digest, Revision Hash를 구분한다. SVG/PNG 및 기타 파생 Export는 입력 Revision과 실제 출력 바이트의 관계를 검증한다. |
| C04 | Archive, Restore, Delete, Reset 및 Export History 변경 경로의 Mutation Guard를 일관되게 적용한다. |
| C05 | 기존 Haruhi TypeScript/Python/Java/Go 및 Takane Python/C/C++/MCU의 실제 출력에 맞는 Content Type을 정의한다. |
| C06 | Soft Delete와 영구 삭제를 구분한다. 삭제된 Artifact의 본문 보존 여부와 명시적 제거 경로를 사용자에게 안내한다. |

## Scope Lock

WO-D01~D04 범위만 허용한다.

WO-D05 이후 구현, Phase 5E/5F 선행 개발, 운영 Gateway 무단 호출, 사용자 코드
자동 실행 및 무단 main 병합·배포를 금지한다.

기존 G6-RES-001~005 이관 사항은 유지한다.
