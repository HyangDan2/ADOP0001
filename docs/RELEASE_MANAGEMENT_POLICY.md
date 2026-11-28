# Release Management Policy (WO-OPS-01)

Applies to ADOP0001 and is reusable for other HD2Lab GitHub Pages services.
Lean Engineering v1.1 governs the work itself: no new features during release
work, only P0/blocking P1 fixes, P2/P3 stay in backlog, no repeated regression
of an unchanged commit.

## 1. Standard lifecycle

```
Feature Development → CI PASS → Beta Deploy Gate → PO UAT
→ defect fix (if needed) → RC Freeze → Main Merge Gate
→ Main CI PASS → Production Deploy Gate
```

Beta verification never triggers production automatically. Each arrow is a
separate decision with its own approval.

## 2. Approvals

| Approval | Authority | Evidence recorded |
| --- | --- | --- |
| Beta deploy | PO | `approval_reference` in dispatch + live manifest |
| Main merge | PO | PR / merge commit |
| Production deploy | PO (after main CI PASS) | `approval_reference` + CI run ID in manifest |
| Beta / production rollback | PO | `approval_reference` + prior approved SHA (and `artifact_run_id` when frozen) |

A workflow run cannot produce a deployment without `approval_reference`,
`source_sha`, and (for production) dispatch from `main`. The approval reference
is not an identity check — it is a traceability record of the PO decision.

## 3. Release channels

- **Beta** — `/ADOP0001/beta/`, any approved branch/RC SHA. Purpose: PO UAT.
  Data isolated by namespace. Removable; removal touches no production bytes and
  no browser data.
- **Production** — `/ADOP0001/`, approved main SHA only.
- **RC freeze** — code SHA, qualification SHA and evidence HEAD are recorded; any
  later product-code change invalidates the qualification evidence.

## 4. Gates

Every deployment runs the quality gate on the exact source SHA: typecheck,
Vitest, and either prior successful CI evidence or the full gate (toolchains,
generated-code QA, project-language QA, E2E). The Pages site is assembled from
the live baseline plus one channel overlay; the untouched channel must be
hash-identical or the deployment aborts. Deployments are serialised by one
concurrency lock.

## 5. Preservation and rollback

The live `site-manifest.json` is authoritative: it records each channel's source
SHA, file hashes, artifact SHA-256, CI run, deployment time and approval
reference. Rollback prefers the frozen `channel-dist-<sha>` artifact; otherwise
the prior approved SHA is rebuilt through the gate. Production rollback must use
the previous approved SHA — never the current live bytes as a source.

## 6. Live Gateway policy

No Live Gateway call is part of beta or production deployment. Live verification
remains NOT TESTED until the PO separately approves cost/service calls. Deployment
approval does not imply Live approval.

## 7. Exceptions and residuals

Current exceptions carried from G7 (unchanged by this order):

- G7-BL-01 Vitest/tinypool/mocker advisories (P2, dev-only, semver-major fix).
- G7-BL-02 Mermaid/KaTeX low advisories (P2, strict rendering).
- G7-BL-03 project preview/bundles not auto-wired into tool execution (P3).
- G6-BL-05 full suite not run on Firefox/WebKit; G7 project specs are.
- G6-BL-06 long-session memory not instrumented.
- G6-RES-002 Live Gateway NOT TESTED.

Deployment additions are themselves subject to backlog if P2/P3: they do not
block the first beta deploy.

## 8. Post-deploy checks

After any approved deployment, verify: both URLs respond, beta badge shows the
deployed SHA, production hashes are unchanged for a beta action (and vice
versa), manifest approval reference matches the dispatch, and no automatic
deploy ran on the main push. Record the results as deployment evidence; never
mark an unexecuted check as PASS.

## 9. Roles

- Q00 — engineering lead, policy and integration.
- Q03 — workflow, build artifacts, deployment integrity.
- Q04 — environment configuration, storage namespace, beta identity UI.
- Q05 — scoped QA for the deployment change only.

Existing squad is reused; no additional agents for standard deployments.