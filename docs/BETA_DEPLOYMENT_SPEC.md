# Beta Deployment Specification (WO-OPS-01)

On-demand, zero-cost beta channel on the existing GitHub Pages site. One
repository, one build pipeline, two channels.

## 1. Channels

| Channel | URL | Source | Publish trigger |
| --- | --- | --- | --- |
| Production | https://hyangdan2.github.io/ADOP0001/ | approved main SHA | `workflow_dispatch` `production-deploy` from `main` + PO approval |
| Beta | https://hyangdan2.github.io/ADOP0001/beta/ | any approved branch/RC SHA | `workflow_dispatch` `beta-deploy` + PO approval |

A push to `main` and a pull request run CI only. Beta never merges to main and
never publishes production. Beta approval, main-merge approval and production
approval are three independent events.

## 2. Build configuration (WO-OPS-01A)

- `vite.config.ts` reads `ADOP_CHANNEL`: `beta` → base `/ADOP0001/beta/`,
  otherwise base `/ADOP0001/`. No second codebase, no copied directories.
- Build metadata is injected at build time and exposed through
  `src/lib/channel.ts`: channel, package version, commit SHA, build time.
- Beta renders a `BETA v<version> · <sha7>` badge (`data-testid="beta-badge"`)
  in the top bar and prefixes the document title with `[BETA]`. Production does
  not render the badge (constant-folded out of the bundle).
- Asset classes verified for the beta base: hashed JS/CSS, images/fonts from
  `public/`, static `manifest.json`, the dynamically loaded
  `vendor/mermaid.min.js`, and hash routes. `npm run test:e2e:beta` builds beta
  and exercises these locally.

## 3. Storage isolation (WO-OPS-01B)

| Domain | Production (unchanged) | Beta |
| --- | --- | --- |
| IndexedDB artifacts | `adop0001-artifacts` | `adop0001-beta-artifacts` |
| IndexedDB drafts | `adop0001-drafts` | `adop0001-beta-drafts` |
| IndexedDB project index | `adop0001-project-index` | `adop0001-beta-project-index` |
| IndexedDB Kotoha | `adop0001-kotoha` | `adop0001-beta-kotoha` |
| IndexedDB few-shot | `adop0001_fewshot_v1` | `adop0001_beta_fewshot_v1` |
| localStorage keys | `adop0001.<key>` | `adop0001.beta.<key>` |
| sessionStorage / Cache Storage / Service Worker | not used | not used |

`namespaceKey` / `namespaceDbName` in `src/lib/channel.ts` are the only mapping
functions; production returns its input unchanged. Beta data is never copied or
migrated from production. The namespace is a collision guard inside one origin,
not a security boundary. Beta removal deletes server-side files only; browser
data stays until the user clears it or uses the app's draft reset. There is no
automatic reset function for beta data — add one explicitly if PO asks.

Gateway settings (base URL, model, sampling) are namespaced; the API key remains
memory-only in both channels and is never persisted.

## 4. Deployment gate (WO-OPS-01C)

`.github/workflows/deploy.yml`, `workflow_dispatch` inputs:

| Input | Meaning |
| --- | --- |
| `action` | `gate-only` (default), `beta-deploy`, `beta-rollback`, `beta-remove`, `production-deploy`, `production-rollback` |
| `source_ref` | branch/tag/SHA that must resolve to `source_sha` |
| `source_sha` | exact 40-char SHA that is checked out and built |
| `approval_reference` | PO approval ticket/reference (required for every action except `gate-only`) |
| `artifact_run_id` | optional frozen channel-dist run for a rollback |

Enforcement:

1. `source_sha` format, `approval_reference`, checkout identity and
   `source_ref → source_sha` are verified before any build.
2. Production actions must be dispatched from `main`.
3. A successful `deploy.yml` run for the SHA is looked up. If found, its run ID
   is recorded and the expensive gate steps (toolchains, `qa:generated`,
   `qa:languages`, E2E) are skipped; if not, this run executes them and only a
   green result reaches deployment.
4. The gate always runs typecheck and Vitest on the exact SHA.
5. All deployments share the `pages-site` concurrency group with
   `cancel-in-progress: false` — beta and production can never assemble from the
   same baseline concurrently.
6. Only the `deploy` job has `pages: write` / `id-token: write`.

## 5. Preservation contract (WO-OPS-01D)

GitHub Pages replaces the entire site per deployment. `tools/release/site.mjs`:

1. `capture` downloads the live site: from `site-manifest.json` when present
   (and verifies every file hash), otherwise by crawling `index.html`, CSS,
   `manifest.json` and the known dynamic imports. A live file that is missing or
   fails its recorded hash aborts the deployment.
2. `assemble` copies the captured tree, removes/replaces only the target channel,
   and recomputes both channel file maps. If the untouched channel differs from
   the captured baseline in any path or byte, assembly fails and nothing is
   published.
3. Root metadata (`site-manifest.json`, `_release/`) is excluded from channel
   file maps.
4. `deploy` uploads the assembled tree, publishes, then `verify` re-downloads the
   manifest and every channel file with cache-busting and compares SHA-256,
   approval reference and file sets.

Manifest shape (`adop0001.site-manifest.v1`):

```json
{
  "kind": "adop0001.site-manifest.v1",
  "updatedAt": "2026-11-28T00:00:00.000Z",
  "channels": {
    "production": {
      "state": "DEPLOYED",
      "sourceSha": "04dd2fc...",
      "files": { "index.html": "<sha256>", "assets/...": "<sha256>" },
      "artifactSha256": "<sha256 of canonical {files}>",
      "deployedAt": "..."
    },
    "beta": {
      "state": "REMOVED",
      "sourceSha": null,
      "files": {},
      "artifactSha256": "<sha256 of {}>",
      "removedAt": "...",
      "lastSourceSha": "13fad26..."
    }
  },
  "deployments": [
    { "action": "beta-deploy", "channel": "beta", "sourceSha": "...", "approvalReference": "PO-...", "ciRunId": "...", "deployedAt": "..." }
  ]
}
```

The manifest is also uploaded as the `deployment-manifest-<action>-<run>` CI
artifact (90 days), and the channel dist as `channel-dist-<sha>` (90 days).

Failure behavior: capture/assembly/verification failures stop the job before
`deploy-pages`; an already-published site is untouched. A post-deploy
verification failure leaves the new site live and fails the run loudly — the
manifest used is attached to the run for investigation.

## 6. Lifecycle (WO-OPS-01E)

| State | Where it is visible |
| --- | --- |
| INACTIVE | no beta channel in the live manifest |
| BUILDING | workflow run in progress |
| READY | channel dist artifact built, not yet published |
| DEPLOYED | `channels.beta.state = DEPLOYED` + live URL |
| FAILED | workflow run failed before `deploy-pages` |
| ROLLED BACK | `deployments[].action = beta-rollback` (state returns to DEPLOYED) |
| REMOVED | `channels.beta.state = REMOVED`, no `/beta/` files |

Removal never touches production files or browser data.

## 7. Rollback

- Preferred: dispatch `beta-rollback` / `production-rollback` with the prior
  approved `source_sha` and the `artifact_run_id` that holds
  `channel-dist-<sha>` — the frozen bytes are redeployed without rebuilding.
- Without a frozen artifact, the same action rebuilds that SHA through the gate
  and deploys it.
- Production rollback requires the previous approved SHA; the current production
  SHA is always visible in the live manifest (`channels.production.sourceSha`).

## 8. Known limitations

- Live capture depends on the site being reachable; if Pages is down, deployment
  fails (by design — no blind overwrite).
- The first deployment introduces `site-manifest.json` and `_release/` metadata
  at the site root. These are not part of either channel's file map.
- Frozen artifacts expire after 90 days; older rollbacks fall back to rebuilding.
- Same-origin namespaces are logical isolation only.
- Go/Java/C# storage semantics are unchanged; only names change per channel.

## 9. Mandatory QA status (WO-OPS-01F)

Non-deploy dry run against the real site (no upload): captured
`https://hyangdan2.github.io/ADOP0001/` (11 production files), assembled a beta
overlay from the beta build (11 beta files), and compared hashes — production
diff `[]`, beta 0 → 11. Manifest recorded `sourceSha 2533b9e`, approval
`DRY-RUN-NO-DEPLOY`, artifact SHA `bae794ec…`.

Verified without deploying:

1. Production and beta URLs — production live; beta local preview under the real
   `/ADOP0001/beta/` base (`test:e2e:beta`). Remote beta URL is PENDING the first
   approved deploy.
2. Beta static resources and dynamic import — PASS locally (`beta-channel.spec.ts`).
3. Production/beta DB and storage key isolation — PASS (unit namespace tests +
   browser localStorage check on the beta build).
4. Beta change/removal leaves production data unchanged — PASS for file bytes
   (assembly tests); browser-data isolation is by namespace (unit).
5. Beta deploy/remove/rollback keeps production file hashes — PASS (assembly
   tests including tamper refusal).
6. Production deploy preserves beta artifacts — PASS (assembly test).
7. CI failure / wrong SHA is refused — static contract verified; live refusal
   PENDING first deployment.
8. No automatic deploy on main push — PASS (workflow condition + docs copy).
9. Beta version and commit SHA display — PASS locally (badge text/title).
10. Concurrent deployment lock and failure preservation — lock and pre-publish
    ordering verified statically; live behavior PENDING first deployment.

Anything requiring the real deployment stays PENDING until PO approves the beta
deploy, as ordered.

## 10. Reusable HD2Lab pattern

For another Pages-hosted HD2Lab app:

1. Add `ADOP_CHANNEL` → base mapping and build metadata injection to its Vite
   config; render a beta badge from that metadata.
2. Put every storage name behind one namespace module; keep production identity.
3. Copy `tools/release/site.mjs` (capture → assemble → verify) and the
   `beta / production` build steps; keep the manifest schema version.
4. Expose the six dispatch actions with `source_sha`, `approval_reference`, a
   shared `pages-site` lock, and Pages write only on the deploy job.
5. Reuse the QA split: local beta preview E2E, assembly unit tests, workflow
   contract tests; real-URL checks only after an approved deploy.