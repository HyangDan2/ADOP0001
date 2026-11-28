/**
 * WO-OPS-01C/E — the deployment gate is a contract. These tests read the
 * workflow itself: actions, approval input, SHA pinning, the shared lock, deploy
 * permissions and the preservation/verification steps must not silently vanish.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const live = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const reference = readFileSync(path.join(ROOT, 'docs/ci-workflow.yml'), 'utf8');
const site = readFileSync(path.join(ROOT, 'tools/release/site.mjs'), 'utf8');

describe('on-demand deployment workflow (WO-OPS-01C)', () => {
  it('offers every lifecycle action and only publishes on dispatch', () => {
    for (const action of ['beta-deploy', 'beta-rollback', 'beta-remove', 'production-deploy', 'production-rollback']) {
      expect(live).toContain(`- ${action}`);
    }
    expect(live).toContain('approval_reference:');
    expect(live).toContain('source_sha:');
    expect(live).toContain('source_ref:');
    expect(live).not.toMatch(/push:\s*\n\s*branches: \[main\]\s*\n\s*pages:/);
    const deploy = live.slice(live.indexOf('\n  deploy:'));
    expect(deploy).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy).not.toContain("github.event_name == 'push'");
  });

  it('pins the exact source SHA and requires an approval reference', () => {
    expect(live).toContain('Pin and verify the deployment SHA');
    expect(live).toContain('test "${#SOURCE_SHA}" -eq 40');
    expect(live).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(live).toContain('approval_reference is required for deployments');
    expect(live).toContain('production deployment must be dispatched from main');
  });

  it('requires prior CI evidence or runs the full gate', () => {
    expect(live).toContain('Prior CI evidence for the SHA');
    expect(live).toContain('--workflow deploy.yml --commit');
    expect(live).toContain("steps.evidence.outputs.found != 'true'");
    expect(live).toContain('npm test');
    expect(live).toContain('npx tsc --noEmit');
  });

  it('serialises every deployment on one lock and scopes Pages write to deploy', () => {
    expect(live).toContain("'pages-site'");
    expect(live).toContain('cancel-in-progress: false');
    const build = live.slice(live.indexOf('\n  build:'), live.indexOf('\n  deploy:'));
    expect(build).not.toContain('pages: write');
    expect(build).not.toContain('id-token: write');
    const deploy = live.slice(live.indexOf('\n  deploy:'));
    expect(deploy).toContain('pages: write');
    expect(deploy).toContain('id-token: write');
    expect(live).not.toContain('continue-on-error');
    expect(live).not.toMatch(/\|\|\s*true/);
  });

  it('preserves and verifies the untouched channel before and after publishing', () => {
    expect(live).toContain('capture --base');
    expect(live).toContain('--action "$ACTION"');
    expect(live).toContain('site.mjs verify');
    expect(site).toContain('Baseline integrity failed');
    expect(site).toContain('would change');
    expect(site).toContain('artifactSha256');
    expect(site).toContain('approvalReference');
    expect(live).toContain('Upload deployment manifest');
  });

  it('keeps the documented gate copy in step with the live workflow', () => {
    for (const marker of ['beta-deploy', 'pages-site', 'approval_reference', 'site.mjs verify']) {
      expect(reference, marker).toContain(marker);
    }
  });
});