# G1 Agent Assignments and Collaboration Protocol

- **Status:** APPROVED WITH IMPLEMENTATION CONDITIONS — CP03 milestone complete
- **Gate:** G0 recorded; CP01 approved (2026-11-27); CP02-00/01/02 complete (`8ecf0aa` contract, integration `80048cb`, CI `45916061189` success); CP03 runtime integration complete (integration `19dff86`, E2E 70/70 locally); CP04 verification and G1 close pending. CP02~CP04 are milestones, not approval gates (Supervisor Lean Engineering v1.1, 2026-11-27).
- **Baseline:** `04dd2fc` (approved candidate `3af2427`; tag `g0-baseline`)
- **Supersedes:** `c5d2221`
- **Date:** 2026-11-27
- **Scope:** WO-D01~D04 and SUP-D01~D07
- **Supervisor disposition:** CONDITIONAL PASS; amendments applied

This document records the six-role Aomatsukan squad, the boundaries that keep
parallel work from overlapping, and the current gate state. It authorizes CP02-01
within WO-D01~D04 only; CP03 is not authorized.

---

## 1. Gate state

| Gate | State | Meaning |
| --- | --- | --- |
| G0 final PO approval | RECORDED 2026-11-27 | PR #12 merged at `04dd2fc`; tree identical to approved `3af2427`; tag `g0-baseline`; CI `45911307876` passed build and Pages deploy. |
| CP01 Interface Freeze | APPROVED WITH IMPLEMENTATION CONDITIONS | C01~C06 corrections are applied in the contract foundation. |
| G1 parallel implementation | CP02 milestone complete; CP03 in progress | Contract SHA `8ecf0aa`; CP02-02 integrated at `80048cb`; CI `45916061189` passed; CP03 runtime integration proceeds under Lean v1.1. |
| CP02 | AUTHORIZED | WO-D01~D04 only; CP03 needs separate approval. |

The CP02 order is registered in `docs/G1_SUP_D01_D07.md`. The correction record is
`docs/CP02_CONTRACT_CORRECTIONS.md`. The document-only branch is
`docs/g1-cp01-interface-freeze`; the integration branch is
`feature/phase5d-artifact-pipeline`, based on `04dd2fc`.

---

## 2. Roles and ownership

| Role | Agent | Scope | Primary deliverables |
| --- | --- | --- | --- |
| Lead | Qoder-00 | Integration, gate control, CP01 evidence, merge authority | CP01 package, assignments, ownership, final integration |
| Core | Qoder-01 | WO-D01/WO-D02 contract, registry, lifecycle | `engine/artifacts/types.ts`, `registry.ts`, `lifecycle.ts`, contract review |
| Intelligence | Qoder-02 | WO-D03 validator contract and policy | Validator registry, validation policy, REQUIRED/OPTIONAL semantics |
| Data | Qoder-03 | WO-D04 repository, schema, transaction | Hash, schema, repository, IndexedDB driver, recovery |
| UI | Qoder-04 | Six-tool runtime integration and export guard | Capture points, AI Apply, Stale, Kotoha paths, ExportGuard |
| QA | Qoder-05 | Independent regression and release evidence | REG-G1-01~29, INV-01~34, E2E harness, PASS/FAIL evidence |

### 2.1 Role boundaries

- Qoder-01 owns the contract vocabulary and type definitions, including
  `inputFingerprint` semantics and content/revision hash field lists. It does not
  define the repository or validator implementation.
- Qoder-02 owns validator selection, validator identity/version/config, and policy
  fingerprint. It imports the contract; it does not define a parallel
  `ArtifactType` or repository.
- Qoder-03 owns persistence and transaction mechanics, content-digest/revision-
  integrity separation, epoch/pointer checks, resource policy, and migration. It
  does not own export UX or tool execution.
- Qoder-04 owns the integration points and export wrapping, including composing
  the fingerprint from actual tool options and rechecking revision identity at
  export click. It does not redefine the contract or write another agent's module.
- Qoder-05 owns independent verification, including options-only Stale, digest
  identity, restore vs duplicate, validator-version invalidation, and epoch races.
  It does not edit implementation to make a test pass and does not change expected
  values.
- Qoder-00 owns integration and the only merge into the integration branch.

### 2.2 CP01-FIX amendment ownership

| Amendment | Owner | Review partner | Contract area |
| --- | --- | --- | --- |
| CP01-FIX-01 Input Identity | Q01 Core / Q04 UI | Q03 Data (binary/cache identity) | `SourceRevision`, `inputFingerprint`, Kotoha slots, existing `artifactRevision.ts` guard |
| CP01-FIX-02 Hash Semantics | Q01 Core / Q03 Data | Q02 (validation binding) | content digest, revision integrity hash, provenance/dependency/source policy, restore vs duplicate |
| CP01-FIX-03 Atomic Concurrency | Q03 Data | Q01 (contract), Q04 (UI surface) | persisted epoch + pointer checks, pre-commit abort, reset/delete/append/validation races |
| CP01-FIX-04 Validator Identity | Q02 Intelligence / Q01 Core | Q04 (tool formats) | validator id/version/config, effective set, policy fingerprint, format coverage |
| CP01-FIX-05 Repository Completion | Q03 Data / Q01 Core | Q04 (UI surface) | list/restore/reset, export history, deletion/retention, persistence reasons, resource policy, migration |
| CP01-FIX-06 Integration & QA | Q04 UI / Q05 QA | Q01/Q02/Q03 | six-tool mapping, Kotoha two paths, export/revision match, async guard, regression matrix |

No amendment owner may introduce an additional contract type. The amended
contract in `docs/G1_CP01_INTERFACE_FREEZE.md` remains the single source.

---

## 3. Work-order assignments

| Work order | Owner | Scope | Status |
| --- | --- | --- | --- |
| WO-D01 | Qoder-01 | Artifact contract and type/interface definitions | Contract draft + CP01-FIX-01/02 amendments; CP01 re-review |
| WO-D02 | Qoder-01 | Lifecycle, validation, freshness, persistence state separation | Contract draft + CP01-FIX-02/04 amendments; CP01 re-review |
| WO-D03 | Qoder-02 | Validator contract, registry, policy, export rules | Compatibility review + CP01-FIX-04 amendments; CP01 re-review |
| WO-D04 | Qoder-03 | Repository, hash, IndexedDB transaction, recovery | Compatibility review + CP01-FIX-02/03/05 amendments; CP01 re-review |
| SUP-D06 | Qoder-04 | Six-tool runtime integration path | Runtime review + CP01-FIX-01/06 amendments; SUP-D01~D07 registration required before CP02 |
| REG-G1 | Qoder-05 | Independent regression matrix and evidence | Matrix + CP01-FIX-06 cases; CP01 re-review |

SUP-D01~D07 source of record is the existing G1 integrated Work Order PART B and
Supervisor Addendum. B-03 is resolved as a registration action: the full text is
registered as a repository-managed document before CP02. That source text is not
present in this workspace, so no agent reproduces or infers it here. No
implementation scope is inferred from an absent text.

---

## 4. Branch and merge policy

- Documentation branch: `docs/g1-cp01-interface-freeze` (this submission).
- Future agent branches, only after approval:
  - `agent/g1-core`
  - `agent/g1-validation`
  - `agent/g1-data`
  - `agent/g1-ui`
  - `agent/g1-qa`
- Integration branch: `feature/phase5d-artifact-pipeline` (created from
  `04dd2fc`; contract at `8ecf0aa`).
- Agent worktrees exist only after the CP02-00 contract SHA; no worktree may be
  created from another SHA.
- No agent merges into the integration branch. Qoder-00 performs integration
  after review.
- A shared file requires the owner's review and Lead approval:
  `src/lib/idb.ts`, `src/lib/artifactRevision.ts`, `src/lib/drafts.ts`,
  `src/components/HybridAssist.tsx`, `src/App.tsx`, and
  `src/tools/kotoha/store.ts`.
- A failed hook, test, or typecheck is fixed at the source. Do not bypass with
  `--no-verify`, force-push, or a relaxed test.

---

## 5. Collaboration protocol

1. Reports go to Qoder-00. Only Qoder-00 reports to the Supervisor.
2. Each agent defines only its owned interfaces and imports the contract. No
   duplicate `ArtifactType`, `ArtifactRevision`, or `ValidationRecord` definitions.
3. Cross-module disagreements are recorded as a decision ID in the CP01 document;
   they are not resolved by inventing a second contract.
4. Implementation starts only after the owner has a written interface handoff and
   the Lead records the approval.
5. Tests use local-only providers and `api.example.invalid` or loopback routes.
   No live gateway is called.
6. No generated or user code is automatically executed.
7. Existing 680 unit tests and 70 E2E tests remain. Tests are not deleted or
   weakened.
8. E2E runs are serial (`workers: 1`, `fullyParallel: false`). No agent starts a
   second E2E run against the same preview port.
9. An agent that finds a defect reports it to the owning engineer. It does not
   edit that owner's implementation or expected values.
10. A claim of completion requires a real commit, test evidence, and a review URL.
    A session callback or a plan is not evidence.
11. Freshness is based on `inputFingerprint` (source, source name, options, binary
    input, engine configuration), never `sourceHash` alone. Options-only changes
    are Stale.
12. No agent adds a post-commit "cleanup" that deletes a successfully committed
    revision because an epoch changed later. Epoch and pointer checks happen
    before commit in the same transaction.
13. Security tests use virtual credentials only. No real key, token, or account is
    stored or transmitted.

---

## 6. CP01 review results

| Reviewer | Review | Result |
| --- | --- | --- |
| Qoder-01 | Contract draft | Eight type contract and artifact/revision policy submitted; accepted as the base |
| Qoder-02 | Validator Registry compatibility | 8-type projection, capability preservation, 1:N validation, REQUIRED-empty UNSUPPORTED |
| Qoder-03 | Repository/Transaction compatibility | Slot unique index, opaque ID, store schema, abort/CAS/multi-tab review |
| Qoder-04 | Runtime integration | Six-tool insertion points, export wrapper, Kotoha/Takane/Kozue special paths |
| Qoder-05 | Independent regression | INV-01~34, REG-G1-01~29 mapping, evidence and limitations |
| Supervisor | CP01 design review | CONDITIONAL PASS; CP01-FIX-01~06 required and applied |

### 6.1 Resolved cross-review issues

- Q02's format-level types are projected into the eight coarse types; no
  capability loss.
- Q03's source-hash-derived key is withdrawn in favor of the slot-based opaque ID.
- Q05's INV-01~26 are the independent verification baseline; INV-27~34 and
  CP01-FIX-06 add fingerprint, hash, validator-identity, epoch, retention, and
  export checks.
- Q04's export wrapper preserves the existing `ExportFormat` signature and
  testids, and now rechecks revision identity at click time.
- Validation records are 1:N append-only history; the effective record is bound to
  the current revision hash, content digest, validator identity, and policy
  fingerprint.
- CP01-FIX-01~06 are applied in the freeze document; no implementation was
  started.

### 6.2 Unresolved decisions

The Supervisor approved CP01 with the C01~C06 implementation conditions. B-03
remains a registration action before CP02-01: the full SUP text is registered
from the existing Work Order PART B and Supervisor Addendum in
`docs/G1_SUP_D01_D07.md`. All gate blockers are closed; the next gate is the
fixed contract SHA. See the freeze document §11.3.

---

## 7. Handoff and next allowed action

1. Supervisor re-review of CP01 is complete: approved with implementation
   conditions.
2. G0 final approval and baseline freeze are recorded at `04dd2fc`
   (tag `g0-baseline`).
3. The SUP-D01~D07 registration is present in
   `docs/G1_SUP_D01_D07.md`.
4. CP02-00 is complete: contract `8ecf0aa`, C01~C06 corrections, contract
   invariants 7/7, full suite 687/687.
5. Qoder-00 integrated CP02-01 at `80048cb`; CI `45916061189` passed (840 unit,
   generated QA 59/0/5, E2E 70).
6. CP03 runtime integration (capture, validation execution, ExportGuard, artifact
   UI) is complete at `19dff86`; CP04 verification proceeds under Supervisor Lean
   Engineering v1.1, and CP02~CP04 are milestones.
7. Independent G1 QA runs at G1 closure, not per milestone.

**Current state: CP03 milestone complete at `19dff86`. CP04 verification and G1 close pending.**
