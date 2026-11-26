# G1 Agent Assignments and Collaboration Protocol

- **Status:** REVIEW REQUESTED
- **Gate:** G0 PO approval not recorded; G1 implementation locked
- **Baseline:** `3af2427`
- **Date:** 2026-11-27
- **Scope:** WO-D01~D04 and SUP-D01~D07

This document records the six-role Aomatsukan squad, the boundaries that keep
parallel work from overlapping, and the current CP01 review state. It does not
authorize implementation.

---

## 1. Gate state

| Gate | State | Meaning |
| --- | --- | --- |
| G0 final PO approval | Not recorded | PR #12 is `OPEN`; no G1 code may be written. |
| CP01 Interface Freeze | REVIEW REQUESTED | This document set is the evidence under review. |
| G1 parallel implementation | Locked | No branch, worktree, source, test, or DB schema work. |
| CP02 | Forbidden | Cannot start before CP01 approval. |

The only permitted work in this state is documentation submission. The
document-only branch is `docs/g1-cp01-interface-freeze`, based on `3af2427`.

---

## 2. Roles and ownership

| Role | Agent | Scope | Primary deliverables |
| --- | --- | --- | --- |
| Lead | Qoder-00 | Integration, gate control, CP01 evidence, merge authority | CP01 package, assignments, ownership, final integration |
| Core | Qoder-01 | WO-D01/WO-D02 contract, registry, lifecycle | `engine/artifacts/types.ts`, `registry.ts`, `lifecycle.ts`, contract review |
| Intelligence | Qoder-02 | WO-D03 validator contract and policy | Validator registry, validation policy, REQUIRED/OPTIONAL semantics |
| Data | Qoder-03 | WO-D04 repository, schema, transaction | Hash, schema, repository, IndexedDB driver, recovery |
| UI | Qoder-04 | Six-tool runtime integration and export guard | Capture points, AI Apply, Stale, Kotoha paths, ExportGuard |
| QA | Qoder-05 | Independent regression and release evidence | REG-G1-01~20, invariants, E2E harness, PASS/FAIL evidence |

### 2.1 Role boundaries

- Qoder-01 owns the contract vocabulary and type definitions. It does not define
  the repository or validator implementation.
- Qoder-02 owns validator selection and policy. It imports the contract; it does
  not define a parallel `ArtifactType` or repository.
- Qoder-03 owns persistence and transaction mechanics. It does not own export UX
  or tool execution.
- Qoder-04 owns the integration points and export wrapping. It does not redefine
  the contract or write another agent's module.
- Qoder-05 owns independent verification. It does not edit implementation to make
  a test pass and does not change expected values.
- Qoder-00 owns integration and the only merge into the integration branch.

---

## 3. Work-order assignments

| Work order | Owner | Scope | Status |
| --- | --- | --- | --- |
| WO-D01 | Qoder-01 | Artifact contract and type/interface definitions | Contract draft submitted; CP01 review |
| WO-D02 | Qoder-01 | Lifecycle, validation, freshness, persistence state separation | Contract draft submitted; CP01 review |
| WO-D03 | Qoder-02 | Validator contract, registry, policy, export rules | Compatibility review submitted; CP01 review |
| WO-D04 | Qoder-03 | Repository, hash, IndexedDB transaction, recovery | Compatibility review submitted; CP01 review |
| SUP-D06 | Qoder-04 | Six-tool runtime integration path | Runtime review submitted; SUP-D06 text absent |
| REG-G1 | Qoder-05 | Independent regression matrix and evidence | Matrix submitted; CP01 review |

SUP-D01~D07 are not present in the repository or delivered materials. SUP-D06
cannot be scoped until the Supervisor provides its text. No agent may infer it.

---

## 4. Branch and merge policy

- Documentation branch: `docs/g1-cp01-interface-freeze` (this submission).
- Future agent branches, only after approval:
  - `agent/g1-core`
  - `agent/g1-validation`
  - `agent/g1-data`
  - `agent/g1-ui`
  - `agent/g1-qa`
- Future integration branch: `feature/phase5d-artifact-pipeline` (not created).
- No agent worktree is created before G0 approval and CP01 approval.
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

---

## 6. CP01 review results

| Reviewer | Review | Result |
| --- | --- | --- |
| Qoder-01 | Contract draft | Eight type contract and artifact/revision policy submitted; accepted as the base |
| Qoder-02 | Validator Registry compatibility | 8-type projection, capability preservation, 1:N validation, REQUIRED-empty UNSUPPORTED |
| Qoder-03 | Repository/Transaction compatibility | Slot unique index, opaque ID, store schema, abort/CAS/multi-tab review |
| Qoder-04 | Runtime integration | Six-tool insertion points, export wrapper, Kotoha/Takane/Kozue special paths |
| Qoder-05 | Independent regression | INV-01~26, REG-G1-01~20 mapping, evidence and limitations |

### 6.1 Resolved cross-review issues

- Q02's format-level types are projected into the eight coarse types; no
  capability loss.
- Q03's source-hash-derived key is withdrawn in favor of the slot-based opaque ID.
- Q05's INV-01~26 are the independent verification baseline.
- Q04's export wrapper preserves the existing `ExportFormat` signature and
  testids.
- Validation records are 1:N append-only history; the effective record is bound to
  the current revision hash and policy.

### 6.2 Unresolved decisions

See `docs/G1_CP01_INTERFACE_FREEZE.md` §11.2 and §11.3. The highest-priority
blockers are G0 approval (B-01), CP01 approval (B-02), missing SUP-D01~D07
(B-03), and the absence of Q01/Q03 source files on disk (B-04).

---

## 7. Handoff and next allowed action

1. Supervisor reviews the four CP01 documents.
2. Supervisor records Interface Freeze approval.
3. PO records G0 final approval and baseline freeze.
4. Only then may Qoder-00 create the integration branch/worktrees and hand off
   implementation to Q01~Q05.
5. CP02 parallel implementation remains forbidden until step 3 is recorded.

**Current state: CP01 REVIEW REQUESTED. No implementation is authorized.**
