/**
 * @vitest-environment node
 *
 * WO-OPS-01D — the deployment assembler must never let one channel rewrite the
 * other. These tests work on real directories and real hashes; the integration
 * case serves the site over HTTP to exercise capture and post-deploy verify.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assembleSite,
  captureSite,
  discoverPaths,
  emptyManifest,
  listFiles,
  readManifest,
  verifyLive,
  type SiteManifest,
} from '../../tools/release/site.mjs';

const roots: string[] = [];
const servers: Server[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adop-site-'));
  roots.push(root);
  return root;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

async function liveSite(): Promise<string> {
  const live = await tempRoot();
  await writeTree(live, {
    'index.html': '<link rel="stylesheet" href="./assets/app.css"><script src="./assets/app.js"></script>',
    'assets/app.js': 'console.log("production");',
    'assets/app.css': 'body{background:url("./bg.png")}',
    'assets/bg.png': 'png-bytes',
    'vendor/mermaid.min.js': 'mermaid',
    'favicon.svg': '<svg/>',
  });
  const manifest = emptyManifest('2026-11-01T00:00:00.000Z');
  const { snapshot } = await import('../../tools/release/site.mjs');
  const files = await snapshot(live);
  manifest.channels.production = {
    state: 'DEPLOYED',
    sourceSha: '04dd2fc',
    files: files.production,
    artifactSha256: 'baseline',
    deployedAt: '2026-11-01T00:00:00.000Z',
  };
  await writeFile(path.join(live, 'site-manifest.json'), JSON.stringify(manifest, null, 2));
  return live;
}

async function betaDist(): Promise<string> {
  const dist = await tempRoot();
  await writeTree(dist, {
    'index.html': '<script src="/ADOP0001/beta/assets/beta.js"></script>',
    'assets/beta.js': 'console.log("beta v2");',
    'vendor/mermaid.min.js': 'mermaid',
  });
  return dist;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('site assembly preserves the non-target channel (WO-OPS-01D)', () => {
  it('deploys beta without changing a single production byte', async () => {
    const live = await liveSite();
    const before = JSON.parse(await readFile(path.join(live, 'site-manifest.json'), 'utf8')) as SiteManifest;
    const out = await tempRoot();
    const result = await assembleSite({
      action: 'beta-deploy',
      liveDir: live,
      distDir: await betaDist(),
      outDir: out,
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-1',
      ciRunId: '46121861832',
      now: '2026-11-28T00:00:00.000Z',
    });

    expect(result.channel).toBe('beta');
    expect(result.manifest.channels.beta.state).toBe('DEPLOYED');
    expect(Object.keys(result.manifest.channels.beta.files).every((file) => file.startsWith('beta/'))).toBe(true);
    expect(result.manifest.channels.production.files).toEqual(before.channels.production.files);
    expect(result.manifest.deployments.at(-1)).toMatchObject({
      action: 'beta-deploy',
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-1',
      ciRunId: '46121861832',
    });
    expect(await readFile(path.join(out, 'beta/assets/beta.js'), 'utf8')).toContain('beta v2');
    expect(await readFile(path.join(out, 'assets/app.js'), 'utf8')).toContain('production');
  });

  it('deploys production without changing the deployed beta bytes', async () => {
    const live = await liveSite();
    const betaOut = await tempRoot();
    await assembleSite({
      action: 'beta-deploy',
      liveDir: live,
      distDir: await betaDist(),
      outDir: betaOut,
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-1',
      ciRunId: 'r1',
      now: '2026-11-28T00:00:00.000Z',
    });
    const betaBefore = (JSON.parse(await readFile(path.join(betaOut, 'site-manifest.json'), 'utf8')) as SiteManifest).channels.beta;

    const prodDist = await tempRoot();
    await writeTree(prodDist, {
      'index.html': '<script src="/ADOP0001/assets/new.js"></script>',
      'assets/new.js': 'console.log("production v2");',
      'favicon.svg': '<svg/>',
      'vendor/mermaid.min.js': 'mermaid',
    });
    const out = await tempRoot();
    const result = await assembleSite({
      action: 'production-deploy',
      liveDir: betaOut,
      distDir: prodDist,
      outDir: out,
      sourceSha: '7d62a89',
      approvalReference: 'PO-PROD-1',
      ciRunId: 'r2',
      now: '2026-11-28T01:00:00.000Z',
    });
    expect(result.manifest.channels.beta).toEqual(betaBefore);
    expect(await readFile(path.join(out, 'beta/assets/beta.js'), 'utf8')).toContain('beta v2');
    expect(await readFile(path.join(out, 'assets/new.js'), 'utf8')).toContain('production v2');
    expect(result.manifest.channels.production.sourceSha).toBe('7d62a89');
  });

  it('removes beta without touching production and records the removal', async () => {
    const live = await liveSite();
    const betaOut = await tempRoot();
    await assembleSite({
      action: 'beta-deploy',
      liveDir: live,
      distDir: await betaDist(),
      outDir: betaOut,
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-1',
      ciRunId: 'r1',
    });
    const out = await tempRoot();
    const result = await assembleSite({
      action: 'beta-remove',
      liveDir: betaOut,
      distDir: await betaDist(),
      outDir: out,
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-REMOVE',
      ciRunId: 'r3',
    });
    expect(result.manifest.channels.beta.state).toBe('REMOVED');
    expect(result.manifest.channels.beta.files).toEqual({});
    expect(result.manifest.channels.beta.lastSourceSha).toBe('13fad26');
    const files = await listFiles(out);
    expect(files.some((file) => file.startsWith('beta/'))).toBe(false);
    expect(files).toContain('assets/app.js');
  });

  it('refuses to deploy when the captured baseline no longer matches its manifest', async () => {
    const live = await liveSite();
    await writeFile(path.join(live, 'assets/app.js'), 'tampered');
    await expect(
      assembleSite({
        action: 'beta-deploy',
        liveDir: live,
        distDir: await betaDist(),
        outDir: await tempRoot(),
        sourceSha: '13fad26',
        approvalReference: 'PO-BETA-1',
        ciRunId: 'r1',
      }),
    ).rejects.toThrow(/Baseline integrity failed/);
  });

  it('refuses to replace a production site it could not capture', async () => {
    const emptyLive = await tempRoot();
    await expect(
      assembleSite({
        action: 'production-deploy',
        liveDir: emptyLive,
        distDir: await betaDist(),
        outDir: await tempRoot(),
        sourceSha: '7d62a89',
        approvalReference: 'PO-PROD-1',
        ciRunId: 'r2',
      }),
    ).rejects.toThrow(/baseline is empty/);
  });

  it('keeps site metadata out of channel file sets', async () => {
    const live = await liveSite();
    const out = await tempRoot();
    const result = await assembleSite({
      action: 'beta-deploy',
      liveDir: live,
      distDir: await betaDist(),
      outDir: out,
      sourceSha: '13fad26',
      approvalReference: 'PO-BETA-1',
      ciRunId: 'r1',
    });
    const files = [...Object.keys(result.files), ...Object.keys(result.manifest.channels.production.files)];
    expect(files.some((file) => file === 'site-manifest.json' || file.startsWith('_release/'))).toBe(false);
    expect(await readManifest(out)).not.toBeNull();
  });
});

describe('site discovery and live verification', () => {
  it('keeps discovered paths on the configured origin and base path', () => {
    const paths = discoverPaths(
      '<a href="../outside.html">x</a><img src="https://evil.example/x.png"><script src="/ADOP0001/assets/a.js"></script><link href="./b.css">',
      'https://hyangdan2.github.io/ADOP0001/index.html',
      'https://hyangdan2.github.io/ADOP0001/',
      'html',
    );
    expect(paths).toEqual(['/ADOP0001/assets/a.js', '/ADOP0001/b.css']);
  });

  it('captures a served site and verifies the deployed bytes', async () => {
    const siteRoot = await liveSite();
    const server = createServer(async (request, response) => {
      const relative = (request.url ?? '/').split('?')[0].replace(/^\/ADOP0001\//, '') || 'index.html';
      try {
        const body = await readFile(path.join(siteRoot, relative));
        response.writeHead(200);
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}/ADOP0001/`;

    // The live site already carries a manifest, so capture downloads exactly that file set.
    const captured = await tempRoot();
    const result = await captureSite({ baseUrl: base, outDir: captured });
    expect(result.files).toContain('assets/app.js');
    const manifest = await readManifest(captured);
    expect(manifest?.channels.production.files['assets/app.js']).toBeTruthy();

    await verifyLive({ baseUrl: base, expectedManifest: manifest as SiteManifest });
    const broken = structuredClone(manifest) as SiteManifest;
    broken.channels.production.files['assets/app.js'] = '0'.repeat(64);
    await expect(verifyLive({ baseUrl: base, expectedManifest: broken })).rejects.toThrow(/bytes differ/);
  });
});