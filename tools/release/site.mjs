/**
 * WO-OPS-01C/D — GitHub Pages site assembly with channel preservation.
 *
 * GitHub Pages replaces the whole site on every deployment, so a beta deploy
 * must carry the current production bytes forward (and vice versa). This script
 * captures the live site, overlays exactly one channel, refuses the deploy when
 * the other channel's file hashes would change, and writes a manifest that
 * binds channel, source SHA, CI run, deployment time and artifact hash.
 *
 * Only Node built-ins are used. Network access is limited to the configured
 * Pages origin.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE_MANIFEST = 'site-manifest.json';
export const MANIFEST_VERSION = 'adop0001.site-manifest.v1';
const META_DIR = '_release/';
const PRODUCTION = 'production';
const BETA = 'beta';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function safeRelative(input) {
  const normal = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normal || normal.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Unsafe site path: ${input}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normal)) throw new Error(`Unsafe site path: ${input}`);
  return normal;
}

export async function listFiles(root) {
  const out = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = safeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) out.push(relative);
    }
  }
  await walk(root, '');
  return out.sort();
}

export function isMetadata(file) {
  return file === SITE_MANIFEST || file.startsWith(META_DIR);
}

export function channelOf(file) {
  if (isMetadata(file)) return null;
  return file === BETA || file.startsWith(`${BETA}/`) ? BETA : PRODUCTION;
}

export async function hashFiles(root, files) {
  const map = {};
  for (const file of [...files].sort()) {
    map[file] = sha256(await readFile(path.join(root, file)));
  }
  return map;
}

export async function snapshot(root) {
  const files = await listFiles(root);
  const production = files.filter((file) => channelOf(file) === PRODUCTION);
  const beta = files.filter((file) => channelOf(file) === BETA);
  return {
    production: await hashFiles(root, production),
    beta: await hashFiles(root, beta),
  };
}

export function diffHashes(expected, actual) {
  const problems = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) problems.push(`missing ${file}`);
    else if (actual[file] !== hash) problems.push(`changed ${file}`);
  }
  for (const file of Object.keys(actual)) {
    if (!(file in expected)) problems.push(`added ${file}`);
  }
  return problems;
}

function channelRecord(state, sourceSha, files, extra = {}) {
  return {
    state,
    sourceSha: sourceSha ?? null,
    files,
    artifactSha256: sha256(canonicalJson({ files })),
    ...extra,
  };
}

export function emptyManifest(now) {
  return {
    kind: MANIFEST_VERSION,
    updatedAt: now,
    channels: {
      production: channelRecord('NONE', null, {}),
      beta: channelRecord('NONE', null, {}),
    },
    deployments: [],
  };
}

export async function readManifest(root) {
  try {
    return JSON.parse(await readFile(path.join(root, SITE_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

export async function verifyBaseline(root, manifest) {
  if (!manifest) return;
  const live = await snapshot(root);
  for (const channel of [PRODUCTION, BETA]) {
    const record = manifest.channels?.[channel];
    if (!record || record.state !== 'DEPLOYED') continue;
    const problems = diffHashes(record.files, live[channel]);
    if (problems.length) {
      throw new Error(`Baseline integrity failed for ${channel}: ${problems.slice(0, 5).join(', ')}`);
    }
  }
}

export function targetFiles(action, files) {
  const channel = action.startsWith('beta-') ? BETA : PRODUCTION;
  if (channel === BETA) return { channel, files: files.filter((file) => channelOf(file) === BETA) };
  return { channel, files: files.filter((file) => channelOf(file) === PRODUCTION) };
}

export async function copyTree(from, to, transform = (file) => file) {
  const files = await listFiles(from);
  for (const file of files) {
    const destination = safeRelative(transform(file));
    const target = path.join(to, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(from, file)));
  }
}

/**
 * Overlay one channel build on a captured live site.
 *
 * @returns {Promise<{manifest: object, channel: string, files: Record<string,string>}>}
 */
export async function assembleSite({
  action,
  liveDir,
  distDir,
  outDir,
  sourceSha,
  approvalReference,
  ciRunId,
  now = new Date().toISOString(),
}) {
  const allowed = ['beta-deploy', 'beta-remove', 'production-deploy', 'production-rollback', 'beta-rollback'];
  if (!allowed.includes(action)) throw new Error(`Unknown deployment action: ${action}`);
  const channel = action.startsWith('beta-') ? BETA : PRODUCTION;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const baseline = (await stat(liveDir)).isDirectory() ? await snapshot(liveDir) : { production: {}, beta: {} };
  const previous = (await readManifest(liveDir)) ?? emptyManifest(now);
  await verifyBaseline(liveDir, previous);
  await copyTree(liveDir, outDir, (file) => file);

  if (action === 'production-deploy' || action === 'production-rollback') {
    if (Object.keys(baseline.production).length === 0) {
      throw new Error('Production baseline is empty; refusing to replace an unknown site');
    }
    await copyTree(distDir, outDir, (file) => (channelOf(file) === BETA ? `${BETA}/${file}` : file));
  } else if (action === 'beta-deploy' || action === 'beta-rollback') {
    await rm(path.join(outDir, BETA), { recursive: true, force: true });
    await copyTree(distDir, outDir, (file) => `${BETA}/${file}`);
  } else {
    await rm(path.join(outDir, BETA), { recursive: true, force: true });
  }

  const next = await snapshot(outDir);
  const untouched = channel === BETA ? PRODUCTION : BETA;
  const problems = diffHashes(baseline[untouched], next[untouched]);
  if (problems.length) {
    throw new Error(`Refusing ${action}: ${untouched} would change (${problems.slice(0, 5).join(', ')})`);
  }

  const manifest = { ...previous, kind: MANIFEST_VERSION, updatedAt: now, channels: { ...previous.channels } };
  const targetHashes = next[channel];
  const state = channel === BETA && action === 'beta-remove' ? 'REMOVED' : 'DEPLOYED';
  manifest.channels[channel] = channelRecord(state, sourceSha, targetHashes, {
    deployedAt: now,
    files: targetHashes,
  });
  // For a removed beta keep the file map empty so a later removal report is honest.
  if (state === 'REMOVED') manifest.channels[channel] = channelRecord('REMOVED', null, {}, { removedAt: now, lastSourceSha: sourceSha });

  manifest.deployments = [
    ...(previous.deployments ?? []),
    { action, channel, sourceSha, approvalReference, ciRunId, deployedAt: now },
  ].slice(-20);

  await mkdir(path.join(outDir, META_DIR, 'manifests'), { recursive: true });
  const history = `${META_DIR}manifests/${channel}-${sourceSha ?? 'removed'}.json`;
  await writeFile(path.join(outDir, SITE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outDir, history), `${JSON.stringify(manifest.channels[channel], null, 2)}\n`);
  return { manifest, channel, files: targetHashes };
}
function decodeEntities(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

export function discoverPaths(text, fromUrl, baseUrl, kind) {
  const refs = new Set();
  const push = (ref) => {
    const clean = decodeEntities(ref).trim();
    if (!clean || clean.startsWith('#') || /^(mailto:|tel:|data:|javascript:)/i.test(clean)) return;
    let url;
    try {
      url = new URL(clean, fromUrl);
    } catch {
      return;
    }
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith(new URL(baseUrl).pathname)) return;
    refs.add(url.pathname);
  };
  if (kind === 'html') {
    for (const match of text.matchAll(/(?:src|href|content)\s*=\s*["']([^"']+)["']/gi)) push(match[1]);
  } else if (kind === 'css') {
    for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) push(match[1]);
  } else if (kind === 'json') {
    for (const match of text.matchAll(/"(?:src|start_url)"\s*:\s*"([^"]+)"/g)) push(match[1]);
  }
  return [...refs];
}

function relativeSitePath(pathname, baseUrl) {
  const basePath = new URL(baseUrl).pathname.replace(/\/?$/, '/');
  const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname.replace(/^\//, '');
  return safeRelative(relative || 'index.html');
}

async function getText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) return null;
  return { text: await response.text(), type: response.headers.get('content-type') ?? '' };
}

/**
 * Capture the live site into a local directory plus a baseline manifest.
 * The first capture (no site-manifest.json yet) discovers files from the HTML,
 * CSS, web manifest and the known dynamic imports.
 */
export async function captureSite({ baseUrl, outDir, extraPaths = ['vendor/mermaid.min.js'] }) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const write = async (relative, body) => {
    const target = path.join(outDir, safeRelative(relative));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  };

  const liveManifest = await getText(new URL(SITE_MANIFEST, base).href);
  if (liveManifest) {
    const parsed = JSON.parse(liveManifest.text);
    await write(SITE_MANIFEST, `${JSON.stringify(parsed, null, 2)}\n`);
    for (const channel of [PRODUCTION, BETA]) {
      const record = parsed.channels?.[channel];
      if (!record || record.state !== 'DEPLOYED') continue;
      for (const [relative, expected] of Object.entries(record.files)) {
        const response = await fetch(new URL(relative, base), { redirect: 'follow' });
        if (!response.ok) throw new Error(`Live file missing: ${relative} (${response.status})`);
        const body = Buffer.from(await response.arrayBuffer());
        if (sha256(body) !== expected) throw new Error(`Live file hash mismatch: ${relative}`);
        await write(relative, body);
      }
    }
    await verifyBaseline(outDir, parsed);
    return { manifest: parsed, files: await listFiles(outDir) };
  }

  const queue = ['index.html', ...extraPaths];
  const seen = new Set();
  while (queue.length) {
    const relative = safeRelative(queue.shift());
    if (seen.has(relative)) continue;
    seen.add(relative);
    const response = await fetch(new URL(relative, base), { redirect: 'follow' });
    if (!response.ok) throw new Error(`Live file missing: ${relative} (${response.status})`);
    const body = Buffer.from(await response.arrayBuffer());
    await write(relative, body);
    const extension = path.extname(relative).toLowerCase();
    const kind = extension === '.html' ? 'html' : extension === '.css' ? 'css' : extension === '.json' ? 'json' : null;
    if (!kind) continue;
    const text = body.toString('utf8');
    for (const pathname of discoverPaths(text, new URL(relative, base).href, base, kind)) {
      queue.push(relativeSitePath(pathname, base));
    }
  }

  const files = await snapshot(outDir);
  const manifest = emptyManifest(new Date().toISOString());
  manifest.channels[PRODUCTION] = channelRecord('DEPLOYED', null, files.production, {
    deployedAt: new Date().toISOString(),
    note: 'captured live baseline',
  });
  await write(SITE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files: await listFiles(outDir) };
}

/**
 * Verify a deployed site against an expected manifest (cache-busted fetches).
 * Retried by the caller while the Pages CDN settles.
 */
export async function verifyLive({ baseUrl, expectedManifest }) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const stamp = Date.now();
  const response = await fetch(`${new URL(SITE_MANIFEST, base).href}?v=${stamp}`);
  if (!response.ok) throw new Error(`Deployed manifest missing (${response.status})`);
  const live = await response.json();
  const problems = [];
  for (const channel of [PRODUCTION, BETA]) {
    const expected = expectedManifest.channels?.[channel];
    const actual = live.channels?.[channel];
    if (!expected) continue;
    if (expected.state !== actual?.state) {
      problems.push(`${channel} state ${actual?.state} != ${expected.state}`);
      continue;
    }
    if (expected.state !== 'DEPLOYED') continue;
    if (actual.artifactSha256 !== expected.artifactSha256) problems.push(`${channel} artifact hash differs`);
    const expectedFiles = Object.keys(expected.files).sort();
    const actualFiles = Object.keys(actual.files ?? {}).sort();
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) problems.push(`${channel} file set differs`);
    for (const file of expectedFiles) {
      const fileResponse = await fetch(`${new URL(file, base).href}?v=${stamp}`);
      if (!fileResponse.ok) {
        problems.push(`${file} missing (${fileResponse.status})`);
        continue;
      }
      const digest = sha256(Buffer.from(await fileResponse.arrayBuffer()));
      if (digest !== expected.files[file]) problems.push(`${file} bytes differ`);
    }
  }
  if (live.deployments?.at(-1)?.approvalReference !== expectedManifest.deployments?.at(-1)?.approvalReference) {
    problems.push('approval reference differs');
  }
  if (problems.length) throw new Error(`Live verification failed: ${problems.slice(0, 8).join('; ')}`);
  return live;
}

async function fetchWithRetry(fn, attempts, delayMs) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw last;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[(index += 1)] : 'true';
    args[key] = value;
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'capture') {
    const result = await captureSite({ baseUrl: args.base, outDir: args.out });
    console.log(`captured ${result.files.length} files from ${args.base}`);
  } else if (command === 'assemble') {
    const result = await assembleSite({
      action: args.action,
      liveDir: args.live,
      distDir: args.dist,
      outDir: args.out,
      sourceSha: args.sha,
      approvalReference: args.approval,
      ciRunId: args.ci,
      now: args.now,
    });
    console.log(`${args.action}: ${result.channel} ${Object.keys(result.files).length} files, artifact ${result.manifest.channels[result.channel].artifactSha256}`);
  } else if (command === 'verify') {
    const expected = JSON.parse(await readFile(args.manifest, 'utf8'));
    await fetchWithRetry(() => verifyLive({ baseUrl: args.base, expectedManifest: expected }), Number(args.attempts ?? 12), Number(args.delay ?? 5000));
    console.log(`verified ${args.base} against ${args.manifest}`);
  } else {
    throw new Error(`Usage: site.mjs capture|assemble|verify ...`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
