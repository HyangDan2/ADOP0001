/**
 * WO-D06 — package import verification (read-only).
 *
 * Import never writes to the repository, adopts nothing and executes nothing.
 * It re-reads the ZIP the user selected, then cross-checks: `SHA256SUMS.txt`
 * against the archive bytes, `manifest.json` against the sums, and every
 * manifest entry against the file it names. The verdict is a plain record the
 * workspace can show (and tests can assert) — no stored state changes.
 */

import JSZip from 'jszip';
import { canonicalJson } from '../../engine/hybrid/canonical';
import { REQUIREMENT_CATALOGUE } from '../../engine/artifacts/traceability';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_MANIFEST_VERSION,
  PACKAGE_SUMS_FILE,
  type PackageManifest,
} from './package';
import { sha256Hex } from './hash';

export const PACKAGE_VERIFICATION_VERSION = 'adop0001.package-verification.v1';

export const PACKAGE_LIMITS = {
  maxEntries: 200,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxSumsBytes: 64 * 1024,
} as const;

export interface PackageSumsEntry {
  path: string;
  sha256: string;
}

export interface PackageVerification {
  version: typeof PACKAGE_VERIFICATION_VERSION;
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: PackageManifest | null;
  manifestHash: string | null;
  manifestText: string | null;
  sums: PackageSumsEntry[];
  files: Array<{ path: string; byteLength: number; sha256: string }>;
  zipHash: string;
  zipByteLength: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

function isUnsafePath(path: string): boolean {
  if (!path || path.includes('\u0000')) return true;
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(path)) return true;
  if (path.includes('\\')) return true;
  return path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

/** Strict `sha256sum` parse: `<64 hex><two spaces><path>`, no extra lines. */
function parseSums(text: string, errors: string[]): PackageSumsEntry[] {
  const entries: PackageSumsEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`SHA256SUMS.txt has an unparsable line: ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    const [, sha256, path] = match;
    if (isUnsafePath(path)) {
      errors.push(`SHA256SUMS.txt names an unsafe path: ${JSON.stringify(path)}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`SHA256SUMS.txt names ${path} more than once`);
      continue;
    }
    seen.add(path);
    entries.push({ path, sha256 });
  }
  return entries;
}

function identityProblem(manifest: PackageManifest, errors: string[]): void {
  if (manifest.manifestVersion !== PACKAGE_MANIFEST_VERSION) {
    errors.push(`Unexpected manifest version: ${String(manifest.manifestVersion)}`);
  }
  if (manifest.format !== 'zip') errors.push('Manifest format is not zip');
  const tool = REQUIREMENT_CATALOGUE.find(
    (requirement) =>
      requirement.toolId === manifest.artifact?.toolId &&
      requirement.artifactTypes.includes(manifest.artifact?.artifactType),
  );
  if (!tool) {
    errors.push(
      `Package identity is not in the requirement catalogue: ${String(manifest.artifact?.toolId)}/${String(manifest.artifact?.artifactType)}`,
    );
  }
  for (const id of manifest.requirements ?? []) {
    if (!REQUIREMENT_CATALOGUE.some((requirement) => requirement.id === id)) {
      errors.push(`Manifest lists an unknown requirement: ${String(id)}`);
    }
  }
  if (!SHA256.test(manifest.revision?.revisionHash ?? '')) {
    errors.push('Manifest revisionHash is not a SHA-256 hex digest');
  }
  if (!SHA256.test(manifest.revision?.contentDigest ?? '')) {
    errors.push('Manifest contentDigest is not a SHA-256 hex digest');
  }
}

export async function inspectArtifactPackage(bytes: Uint8Array): Promise<PackageVerification> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: PackageVerification = {
    version: PACKAGE_VERIFICATION_VERSION,
    ok: false,
    errors,
    warnings,
    manifest: null,
    manifestHash: null,
    manifestText: null,
    sums: [],
    files: [],
    zipHash: '',
    zipByteLength: bytes.byteLength,
  };

  if (bytes.byteLength === 0) {
    errors.push('The selected file is empty');
    return result;
  }
  if (bytes.byteLength > PACKAGE_LIMITS.maxTotalBytes) {
    errors.push(`The selected file exceeds ${PACKAGE_LIMITS.maxTotalBytes} bytes`);
    return result;
  }
  result.zipHash = await sha256Hex(bytes);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    errors.push('The selected file is not a readable ZIP archive');
    return result;
  }

  const names = Object.keys(zip.files);
  if (names.length > PACKAGE_LIMITS.maxEntries) {
    errors.push(`The archive holds ${names.length} entries (limit ${PACKAGE_LIMITS.maxEntries})`);
    return result;
  }
  for (const name of names) {
    if (isUnsafePath(name)) errors.push(`The archive holds an unsafe path: ${JSON.stringify(name)}`);
  }

  const manifestEntry = zip.file(PACKAGE_MANIFEST_FILE);
  if (!manifestEntry) {
    errors.push(`The archive has no ${PACKAGE_MANIFEST_FILE}`);
    return result;
  }
  const sumsEntry = zip.file(PACKAGE_SUMS_FILE);
  if (!sumsEntry) {
    errors.push(`The archive has no ${PACKAGE_SUMS_FILE}`);
    return result;
  }

  const manifestBytes = await manifestEntry.async('uint8array');
  if (manifestBytes.byteLength > PACKAGE_LIMITS.maxManifestBytes) {
    errors.push(`${PACKAGE_MANIFEST_FILE} exceeds ${PACKAGE_LIMITS.maxManifestBytes} bytes`);
    return result;
  }
  const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  result.manifestText = manifestText;
  result.manifestHash = await sha256Hex(manifestBytes);

  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(manifestText) as PackageManifest;
  } catch {
    errors.push(`${PACKAGE_MANIFEST_FILE} is not valid JSON`);
    return result;
  }
  result.manifest = manifest;
  if (canonicalJson(manifest) !== manifestText) {
    errors.push(`${PACKAGE_MANIFEST_FILE} is not in canonical form`);
  }
  identityProblem(manifest, errors);

  const sumsBytes = await sumsEntry.async('uint8array');
  if (sumsBytes.byteLength > PACKAGE_LIMITS.maxSumsBytes) {
    errors.push(`${PACKAGE_SUMS_FILE} exceeds ${PACKAGE_LIMITS.maxSumsBytes} bytes`);
    return result;
  }
  const sums = parseSums(
    new TextDecoder('utf-8', { fatal: true }).decode(sumsBytes),
    errors,
  );
  result.sums = sums;
  const sumFor = new Map(sums.map((entry) => [entry.path, entry.sha256]));

  if (sumFor.get(PACKAGE_MANIFEST_FILE) !== result.manifestHash) {
    errors.push(`${PACKAGE_SUMS_FILE} does not list the archive's ${PACKAGE_MANIFEST_FILE} hash`);
  }

  const manifestFiles = new Map<string, PackageManifest['files'][number]>();
  for (const file of manifest.files ?? []) {
    if (isUnsafePath(file.path)) {
      errors.push(`Manifest names an unsafe path: ${JSON.stringify(file.path)}`);
      continue;
    }
    if (manifestFiles.has(file.path)) {
      errors.push(`Manifest names ${file.path} more than once`);
      continue;
    }
    if (!SHA256.test(file.sha256)) {
      errors.push(`Manifest entry ${file.path} has no SHA-256 digest`);
      continue;
    }
    manifestFiles.set(file.path, file);
  }

  if (manifestFiles.has(PACKAGE_SUMS_FILE) || manifestFiles.has(PACKAGE_MANIFEST_FILE)) {
    errors.push('Manifest must not list its own package metadata files');
  }

  const archiveFiles = new Set([PACKAGE_MANIFEST_FILE, PACKAGE_SUMS_FILE, ...manifestFiles.keys()]);
  const sumsCovered = new Set([PACKAGE_MANIFEST_FILE, ...manifestFiles.keys()]);
  for (const entry of sums) {
    if (!sumsCovered.has(entry.path)) {
      errors.push(`${PACKAGE_SUMS_FILE} lists an unexpected file: ${entry.path}`);
    }
  }
  for (const path of sumsCovered) {
    if (!sumFor.has(path)) errors.push(`${PACKAGE_SUMS_FILE} does not cover ${path}`);
  }

  for (const name of names) {
    if (zip.files[name].dir) continue;
    if (!archiveFiles.has(name)) errors.push(`The archive holds an unlisted file: ${JSON.stringify(name)}`);
  }

  let total = 0;
  for (const [path, file] of manifestFiles) {
    const entry = zip.file(path);
    if (!entry) {
      errors.push(`The archive is missing ${path}`);
      continue;
    }
    const entryBytes = await entry.async('uint8array');
    if (entryBytes.byteLength > PACKAGE_LIMITS.maxEntryBytes) {
      errors.push(`${path} exceeds ${PACKAGE_LIMITS.maxEntryBytes} bytes`);
    }
    total += entryBytes.byteLength;
    if (total > PACKAGE_LIMITS.maxTotalBytes) {
      errors.push(`Unpacked bytes exceed ${PACKAGE_LIMITS.maxTotalBytes}`);
      break;
    }
    const digest = await sha256Hex(entryBytes);
    result.files.push({ path, byteLength: entryBytes.byteLength, sha256: digest });
    if (entryBytes.byteLength !== file.byteLength) {
      errors.push(`${path} length ${entryBytes.byteLength} does not match the manifest (${file.byteLength})`);
    }
    if (digest !== file.sha256) errors.push(`${path} hash does not match the manifest`);
    if (sumFor.get(path) !== digest) errors.push(`${path} hash does not match ${PACKAGE_SUMS_FILE}`);
  }

  warnings.push(
    'contentDigest and revisionHash are recorded, not recomputed: the manifest keeps the exported entry names, not the stored originals.',
  );

  result.ok = errors.length === 0;
  return result;
}
