# G1 File Ownership Matrix

- **Status:** REVIEW REQUESTED
- **Gate:** G0 PO approval not recorded; G1 implementation locked
- **Baseline:** `3af2427`
- **Date:** 2026-11-27

This matrix assigns proposed G1 paths to one owner. Paths marked "proposed" do not
exist yet; they are created only after G0 approval and CP01 approval. A shared
file requires the owner's review and Qoder-00's approval.

---

## 1. New contract and engine modules

| Path | Owner | Purpose |
| --- | --- | --- |
| `src/engine/artifacts/types.ts` | Q01 Core | Artifact contract, descriptor, revision, validation types |
| `src/engine/artifacts/registry.ts` | Q01 Core | Eight descriptors, content selectors, capability checks |
| `src/engine/artifacts/lifecycle.ts` | Q01 Core | Lifecycle transitions and export eligibility |
| `src/engine/artifacts/index.ts` | Q01 Core | Public exports for the artifact engine |
| `src/engine/artifacts/validation/registry.ts` | Q02 Intelligence | Validator registry and selection |
| `src/engine/artifacts/validation/policy.ts` | Q02 Intelligence | REQUIRED/OPTIONAL policy, effective record |
| `src/engine/artifacts/validation/index.ts` | Q02 Intelligence | Public validation exports |

## 2. New persistence modules

| Path | Owner | Purpose |
| --- | --- | --- |
| `src/lib/idb.ts` | Q03 Data (Lead approval) | Shared IndexedDB open/transaction driver |
| `src/lib/artifacts/hash.ts` | Q03 Data | Canonical text/binary/JSON/manifest SHA-256 |
| `src/lib/artifacts/schema.ts` | Q03 Data | `adop0001-artifacts` v1 schema and version gate |
| `src/lib/artifacts/repository.ts` | Q03 Data | Slot identity, append, CAS, validation commit |
| `src/lib/artifacts/index.ts` | Q03 Data | Public repository exports |

## 3. New integration modules

| Path | Owner | Purpose |
| --- | --- | --- |
| `src/lib/artifactCapture.ts` | Q04 UI | Engine result/AI Apply → revision; restore |
| `src/lib/artifactLinks.ts` | Q04 UI | Draft artifact-link map read/write and repair |
| `src/components/artifacts/ExportGuard.ts` | Q04 UI | Wraps `ExportFormat.run/copy` |
| `src/components/artifacts/ArtifactStatus.tsx` | Q04 UI | Stale/validation/persistence status display |
| `src/components/artifacts/RevisionHistory.tsx` | Q04 UI | Revision list and restore action |

## 4. Existing shared files

| Path | Owner | Change rule |
| --- | --- | --- |
| `src/adapters/types.ts` | Q01 Core | No change planned; type-only imports |
| `src/engine/core/contracts.ts` | Q01 Core | No change planned; capture layer consumes `ExecutionContext` |
| `src/engine/core/runner.ts` | Q01 Core | No change planned; no new cache behavior |
| `src/lib/artifactRevision.ts` | Q04 UI (Q01 review) | Replace reference equality with ID/hash identity; preserve messages |
| `src/lib/drafts.ts` | Q04 UI (Lead approval) | Optional draft link field; no change to DB name/version/store |
| `src/components/ExportModal.tsx` | Q04 UI | **No change**; guard is applied outside the modal |
| `src/components/HybridAssist.tsx` | Q04 UI (Lead approval) | One central AI Apply registration point |
| `src/tools/kotoha/store.ts` | Q04 UI (Q03 review) | `KOTOHA_DRAFT_VERSION` 1→2 and optional artifact links |
| `src/App.tsx` | Q04 UI (Lead approval) | Separate artifact-history reset; draft reset unchanged |
| `src/tools/shiori/ShioriTool.tsx` | Q04 UI | Run/AI Apply/Stale capture only |
| `src/tools/yayoi/YayoiTool.tsx` | Q04 UI | Run/AI Apply/Stale capture only |
| `src/tools/kozue/KozueTool.tsx` | Q04 UI | Run/AI Apply/Stale capture only |
| `src/tools/haruhi/HaruhiTool.tsx` | Q04 UI | Run/AI Apply/Stale capture only |
| `src/tools/kotoha/KotohaTool.tsx` | Q04 UI | Adopt/rebuild/AI Apply/Stale capture; preserve docxSource |
| `src/tools/takane/TakaneTool.tsx` | Q04 UI | Run/AI Apply/Stale capture; deterministic all-files export |

## 5. Tests and evidence

| Path/area | Owner | Rule |
| --- | --- | --- |
| `tests/artifacts/**` unit tests | Q01/Q02/Q03 by module | Owner writes tests for its own module; Q05 reviews independence |
| `tests/lib/artifactCapture.test.ts` | Q04 UI | Integration unit tests; no expected-value change for existing tests |
| `tests/e2e/artifacts/reg-g1-*.spec.ts` | Q05 QA | Independent E2E; no implementation edits |
| `tests/e2e/artifacts/helpers/**` | Q05 QA | Context request log, IDB dump, two-tab harness |
| `docs/G1_REGRESSION_MATRIX.md` | Q05 QA | Evidence matrix; maintained by QA |
| `docs/G1_CP01_INTERFACE_FREEZE.md` | Q01 Core / Q00 Lead | Contract and decisions |
| `docs/G1_AGENT_ASSIGNMENTS.md` | Q00 Lead | Roles, gates, protocol |
| `docs/G1_FILE_OWNERSHIP.md` | Q00 Lead | This matrix |

No existing test file is modified to accommodate a new implementation. New tests
are additive. A defect is reported to the owning engineer; the QA agent does not
change the implementation to make a test pass.

## 6. Review and merge rules

1. Every shared file change requires the owner's review and Qoder-00's approval.
2. Q03's `src/lib/idb.ts` is a shared driver. Q04 consumes it; Q04 does not fork
   its own IndexedDB wrapper.
3. Q02's validation modules do not import the repository. Q03's repository does
   not import the validation engine. The capture layer composes them.
4. Q04 does not modify `ExportModal.tsx`; the guard wraps the format array.
5. Q01 owns `ArtifactType`; no other agent declares a parallel type.
6. Q05 may add tests but must not edit implementation. If a test reveals a defect,
   it is assigned to the owner.
7. Only Qoder-00 merges into the integration branch after G0/CP01 approval.
8. No agent creates a worktree before approval.

## 7. Current state

All paths in sections 1-3 and 5 are proposals. Only this documentation set exists
on the review branch. The baseline `3af2427` is unchanged.

**CP01 state: REVIEW REQUESTED.**
