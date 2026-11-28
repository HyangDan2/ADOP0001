/**
 * WO-D06 / G2-FIX-02 — safe package inspection (read-only).
 *
 * Import never writes to the repository, adopts nothing and executes nothing.
 * The verifier reads the ZIP's central directory first and refuses oversized,
 * over-compressed, duplicated or unsafe archives before anything is
 * decompressed; only then does it cross-check `SHA256SUMS.txt`, the manifest
 * schema, the nested single-package manifests of a project archive and the
 * actual entry bytes.
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
import {
  PROJECT_PACKAGE_DIR,
  PROJECT_PACKAGE_MANIFEST,
  PROJECT_PACKAGE_SUMS,
  PROJECT_PACKAGE_VERSION,
  type ProjectPackageManifest,
} from './projectPackage';
import { sha256Hex } from './hash';

export const PACKAGE_VERIFICATION_VERSION = 'adop0001.package-verification.v2';

export const PACKAGE_LIMITS = {
  maxEntries: 200,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxSumsBytes: 64 * 1024,
  /** Above this uncompressed size an entry must not compress beyond 100:1. */
  ratioCheckAboveBytes: 1024 * 1024,
  maxCompressionRatio: 100,
} as const;

/** File-selection gate: refuse oversized input before it is read into memory. */
export function isSelectablePackageSize(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= PACKAGE_LIMITS.maxTotalBytes;
}

interface InternalStreamHelper {
  on(event: 'data', callback: (chunk: Uint8Array) => void): InternalStreamHelper;
  on(event: 'end', callback: () => void): InternalStreamHelper;
  on(event: 'error', callback: (error: unknown) => void): InternalStreamHelper;
  resume(): InternalStreamHelper;
  pause(): InternalStreamHelper;
}

interface InternalStreamEntry {
  internalStream(type: 'uint8array'): InternalStreamHelper;
}

interface ExtractionBudget {
  total: number;
}

/**
 * Inflate one entry and refuse the moment the produced bytes pass the cap.
 * The stream is paused on refusal, so the check happens during decompression,
 * not after the whole entry has been materialised.
 */
async function inflateCapped(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  budget: ExtractionBudget,
  label: string,
): Promise<Uint8Array> {
  const stream = (entry as unknown as InternalStreamEntry).internalStream('uint8array');
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream
      .on('data', (chunk) => {
        if (settled) return;
        size += chunk.byteLength;
        if (size > maxBytes) {
          fail(new Error(`${label} exceeds ${maxBytes} bytes while decompressing`));
          return;
        }
        if (budget.total + size > PACKAGE_LIMITS.maxTotalBytes) {
          fail(new Error(`Unpacked bytes exceed ${PACKAGE_LIMITS.maxTotalBytes} while decompressing`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (cause) => {
        fail(cause instanceof Error ? cause : new Error(`${label} could not be decompressed`));
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        budget.total += size;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(bytes);
      })
      .resume();
  });
}

export interface PackageSumsEntry {
  path: string;
  sha256: string;
}

export type PackageManifestValue = PackageManifest | ProjectPackageManifest;

export interface PackageVerification {
  version: typeof PACKAGE_VERIFICATION_VERSION;
  kind: 'artifact' | 'project';
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: PackageManifestValue | null;
  manifestPath: string | null;
  manifestHash: string | null;
  manifestText: string | null;
  sums: PackageSumsEntry[];
  files: Array<{ path: string; byteLength: number; sha256: string }>;
  zipHash: string;
  zipByteLength: number;
  /** Entries read from the central directory, before decompression. */
  declaredEntries: number;
}

interface DirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const RELATIONS = new Set(['derived-from', 'validates', 'packages']);

function isUnsafePath(rawPath: string): boolean {
  if (!rawPath || rawPath.includes('\u0000')) return true;
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(rawPath)) return true;
  if (rawPath.includes('\\')) return true;
  const trimmed = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (!trimmed) return false;
  return trimmed.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

function isBoundedString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal ZIP central-directory read: sizes and names without decompression. */
function readZipDirectory(bytes: Uint8Array): { entries: DirectoryEntry[]; error: string | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.byteLength < minEocd) return { entries: [], error: 'The selected file is not a ZIP archive' };
  let eocd = -1;
  const floor = Math.max(0, bytes.byteLength - minEocd - 0xffff);
  for (let offset = bytes.byteLength - minEocd; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + minEocd + commentLength === bytes.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return { entries: [], error: 'The selected file is not a readable ZIP archive' };

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const total = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return { entries: [], error: 'Multi-volume and ZIP64 archives are not accepted' };
  }
  if (centralOffset + centralSize > eocd) {
    return { entries: [], error: 'The ZIP central directory is out of bounds' };
  }

  const entries: DirectoryEntry[] = [];
  let cursor = centralOffset;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      return { entries: [], error: 'The ZIP central directory is malformed' };
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    if (cursor + 46 + nameLength > bytes.byteLength) {
      return { entries: [], error: 'The ZIP central directory is truncated' };
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return { entries: [], error: 'ZIP64 entries are not accepted' };
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, error: null };
}

function preflight(zip: Uint8Array): { entries: DirectoryEntry[]; errors: string[] } {
  const { entries, error } = readZipDirectory(zip);
  const errors: string[] = [];
  if (error) {
    errors.push(error);
    return { entries, errors };
  }
  if (entries.length > PACKAGE_LIMITS.maxEntries) {
    errors.push(`The archive holds ${entries.length} entries (limit ${PACKAGE_LIMITS.maxEntries})`);
  }
  const seen = new Set<string>();
  const normalized = new Set<string>();
  let declaredTotal = 0;
  for (const entry of entries) {
    const isDir = entry.name.endsWith('/');
    if (seen.has(entry.name)) errors.push(`The archive repeats an entry name: ${JSON.stringify(entry.name)}`);
    seen.add(entry.name);
    if (isUnsafePath(entry.name)) {
      errors.push(`The archive holds an unsafe path: ${JSON.stringify(entry.name)}`);
    }
    const normalizedName = entry.name.replace(/\/+$/, '').replace(/^(\.\/)+/, '');
    if (normalized.has(normalizedName)) {
      errors.push(`The archive has a duplicate after normalisation: ${JSON.stringify(normalizedName)}`);
    }
    normalized.add(normalizedName);
    if (isDir) continue;
    if (entry.method !== 0 && entry.method !== 8) {
      errors.push(`Entry ${JSON.stringify(entry.name)} uses unsupported compression method ${entry.method}`);
    }
    if (entry.uncompressedSize > PACKAGE_LIMITS.maxEntryBytes) {
      errors.push(`Entry ${JSON.stringify(entry.name)} declares ${entry.uncompressedSize} bytes (limit ${PACKAGE_LIMITS.maxEntryBytes})`);
    }
    if (
      entry.uncompressedSize > PACKAGE_LIMITS.ratioCheckAboveBytes &&
      (entry.compressedSize === 0 ||
        entry.uncompressedSize / entry.compressedSize > PACKAGE_LIMITS.maxCompressionRatio)
    ) {
      errors.push(`Entry ${JSON.stringify(entry.name)} exceeds the ${PACKAGE_LIMITS.maxCompressionRatio}:1 compression limit`);
    }
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > PACKAGE_LIMITS.maxTotalBytes) {
    errors.push(`The archive declares ${declaredTotal} unpacked bytes (limit ${PACKAGE_LIMITS.maxTotalBytes})`);
  }
  return { entries, errors };
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
      errors.push(`SHA256SUMS has an unparsable line: ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    const [, sha256, path] = match;
    if (isUnsafePath(path)) {
      errors.push(`SHA256SUMS names an unsafe path: ${JSON.stringify(path)}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`SHA256SUMS names ${path} more than once`);
      continue;
    }
    seen.add(path);
    entries.push({ path, sha256 });
  }
  return entries;
}

function dependencyProblems(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} dependencies must be an array`);
    return;
  }
  for (const item of value) {
    if (!isRecord(item) || !isBoundedString(item.artifactId) || !isBoundedString(item.revisionId)) {
      errors.push(`${label} has a malformed dependency`);
      continue;
    }
    if (typeof item.relation !== 'string' || !RELATIONS.has(item.relation)) {
      errors.push(`${label} has an unknown dependency relation`);
    }
  }
}

function requirementProblems(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > 100) {
    errors.push(`${label} requirements must be a bounded array`);
    return;
  }
  for (const id of value) {
    if (!isBoundedString(id, 40) || !REQUIREMENT_CATALOGUE.some((requirement) => requirement.id === id)) {
      errors.push(`${label} lists an unknown requirement: ${String(id)}`);
    }
  }
}

function fileProblems(value: unknown, errors: string[]): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    errors.push('Manifest files must be an array');
    return false;
  }
  for (const file of value) {
    if (!isRecord(file)) {
      errors.push('Manifest has a malformed file entry');
      continue;
    }
    if (typeof file.path !== 'string' || isUnsafePath(file.path)) {
      errors.push(`Manifest names an unsafe path: ${String(file.path)}`);
      continue;
    }
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      errors.push(`Manifest entry ${file.path} has no SHA-256 digest`);
    }
    if (typeof file.byteLength !== 'number' || !Number.isInteger(file.byteLength) || file.byteLength < 0) {
      errors.push(`Manifest entry ${file.path} has no valid length`);
    }
  }
  return true;
}

function validateArtifactManifest(manifest: PackageManifest, errors: string[]): void {
  if (manifest.manifestVersion !== PACKAGE_MANIFEST_VERSION) {
    errors.push(`Unexpected manifest version: ${String(manifest.manifestVersion)}`);
  }
  if (manifest.format !== 'zip') errors.push('Manifest format is not zip');
  if (!isRecord(manifest.artifact) || !isBoundedString(manifest.artifact.artifactId)) {
    errors.push('Manifest artifact identity is malformed');
  } else {
    const tool = REQUIREMENT_CATALOGUE.find(
      (requirement) =>
        requirement.toolId === manifest.artifact.toolId &&
        requirement.artifactTypes.includes(manifest.artifact.artifactType),
    );
    if (!tool) {
      errors.push(
        `Package identity is not in the requirement catalogue: ${String(manifest.artifact.toolId)}/${String(manifest.artifact.artifactType)}`,
      );
    }
  }
  if (!isRecord(manifest.revision) || !isBoundedString(manifest.revision.revisionId)) {
    errors.push('Manifest revision identity is malformed');
  } else {
    if (!SHA256.test(manifest.revision.revisionHash ?? '')) errors.push('Manifest revisionHash is not a SHA-256 hex digest');
    if (!SHA256.test(manifest.revision.contentDigest ?? '')) errors.push('Manifest contentDigest is not a SHA-256 hex digest');
  }
  dependencyProblems(manifest.dependencies, 'Manifest', errors);
  requirementProblems(manifest.requirements, 'Manifest', errors);
  if (manifest.validation !== null && !isRecord(manifest.validation)) {
    errors.push('Manifest validation is malformed');
  }
  if (fileProblems(manifest.files, errors)) {
    const paths = new Set<string>();
    for (const file of manifest.files) {
      const path = String(file.path);
      if (paths.has(path)) errors.push(`Manifest names ${path} more than once`);
      paths.add(path);
    }
    if (paths.has(PACKAGE_SUMS_FILE) || paths.has(PACKAGE_MANIFEST_FILE)) {
      errors.push('Manifest must not list its own package metadata files');
    }
  }
}

function validateProjectManifest(manifest: ProjectPackageManifest, errors: string[]): void {
  if (manifest.manifestVersion !== PROJECT_PACKAGE_VERSION) {
    errors.push(`Unexpected project manifest version: ${String(manifest.manifestVersion)}`);
  }
  if (manifest.format !== 'zip') errors.push('Project manifest format is not zip');
  if (typeof manifest.includeSource !== 'boolean') errors.push('Project manifest includeSource must be boolean');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > 50) {
    errors.push('Project manifest artifacts must be a bounded non-empty array');
  } else {
    const seen = new Set<string>();
    for (const item of manifest.artifacts) {
      if (!isRecord(item) || !isBoundedString(item.artifactId) || !isBoundedString(item.artifactType)) {
        errors.push('Project manifest has a malformed artifact entry');
        continue;
      }
      if (seen.has(item.artifactId)) errors.push(`Project manifest repeats artifact ${item.artifactId}`);
      seen.add(item.artifactId);
      const known = REQUIREMENT_CATALOGUE.some(
        (requirement) =>
          requirement.toolId === item.toolId && requirement.artifactTypes.includes(item.artifactType),
      );
      if (!known) errors.push(`Project artifact ${item.artifactId} is not in the requirement catalogue`);
      if (!isRecord(item.revision) || !isBoundedString(item.revision.revisionId)) {
        errors.push(`Project artifact ${item.artifactId} has a malformed revision`);
      } else if (
        !SHA256.test(String(item.revision.revisionHash)) ||
        !SHA256.test(String(item.revision.contentDigest))
      ) {
        errors.push(`Project artifact ${item.artifactId} revision hashes are not SHA-256 digests`);
      }
      if (typeof item.packageManifestPath !== 'string' || !item.packageManifestPath.startsWith(`${PROJECT_PACKAGE_DIR}/`)) {
        errors.push(`Project artifact ${item.artifactId} package manifest path is outside the project directory`);
      }
      if (typeof item.packageManifestHash !== 'string' || !SHA256.test(item.packageManifestHash)) {
        errors.push(`Project artifact ${item.artifactId} package manifest hash is not a SHA-256 digest`);
      }
      dependencyProblems(item.dependencies, `Project artifact ${item.artifactId}`, errors);
      requirementProblems(item.requirements, `Project artifact ${item.artifactId}`, errors);
      if (item.validation !== null && !isRecord(item.validation)) {
        errors.push(`Project artifact ${item.artifactId} validation is malformed`);
      }
    }
  }
  requirementProblems(manifest.requirements, 'Project', errors);
  if (fileProblems(manifest.files, errors)) {
    const paths = new Set<string>();
    for (const file of manifest.files) {
      const path = String(file.path);
      if (paths.has(path)) errors.push(`Project manifest names ${path} more than once`);
      paths.add(path);
      if (!path.startsWith(`${PROJECT_PACKAGE_DIR}/`)) {
        errors.push(`Project file ${path} is outside the project directory`);
      }
      if (file.role !== 'package' && file.role !== 'source') {
        errors.push(`Project file ${path} has an unknown role`);
      }
      if (!isBoundedString(file.artifactId)) {
        errors.push(`Project file ${path} names no artifact`);
      } else if (Array.isArray(manifest.artifacts) && !manifest.artifacts.some((artifact) => artifact.artifactId === file.artifactId)) {
        errors.push(`Project file ${path} names an artifact outside the selection`);
      }
      if (file.role === 'source' && manifest.includeSource !== true) {
        errors.push(`Project file ${path} is a source snapshot but includeSource is false`);
      }
    }
  }
}

export async function inspectArtifactPackage(bytes: Uint8Array): Promise<PackageVerification> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: PackageVerification = {
    version: PACKAGE_VERIFICATION_VERSION,
    kind: 'artifact',
    ok: false,
    errors,
    warnings,
    manifest: null,
    manifestPath: null,
    manifestHash: null,
    manifestText: null,
    sums: [],
    files: [],
    zipHash: '',
    zipByteLength: bytes.byteLength,
    declaredEntries: 0,
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

  const pre = preflight(bytes);
  result.declaredEntries = pre.entries.length;
  if (pre.errors.length > 0) {
    errors.push(...pre.errors);
    return result;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    errors.push('The selected file is not a readable ZIP archive');
    return result;
  }

  const archiveNames = Object.keys(zip.files);
  const rawFiles = pre.entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name);
  if (rawFiles.length !== archiveNames.filter((name) => !zip.files[name].dir).length) {
    errors.push('The archive entry list does not survive normalisation');
    return result;
  }

  const isProject = !zip.file(PACKAGE_MANIFEST_FILE) && Boolean(zip.file(PROJECT_PACKAGE_MANIFEST));
  result.kind = isProject ? 'project' : 'artifact';
  const manifestPath = isProject ? PROJECT_PACKAGE_MANIFEST : PACKAGE_MANIFEST_FILE;
  const sumsPath = isProject ? PROJECT_PACKAGE_SUMS : PACKAGE_SUMS_FILE;
  result.manifestPath = manifestPath;

  const manifestEntry = zip.file(manifestPath);
  if (!manifestEntry) {
    errors.push(`The archive has no ${manifestPath}`);
    return result;
  }
  const sumsEntry = zip.file(sumsPath);
  if (!sumsEntry) {
    errors.push(`The archive has no ${sumsPath}`);
    return result;
  }

  const budget: ExtractionBudget = { total: 0 };
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await inflateCapped(
      manifestEntry,
      PACKAGE_LIMITS.maxManifestBytes,
      budget,
      manifestPath,
    );
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : `${manifestPath} could not be decompressed`);
    return result;
  }
  const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  result.manifestText = manifestText;
  result.manifestHash = await sha256Hex(manifestBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    errors.push(`${manifestPath} is not valid JSON`);
    return result;
  }
  if (!isRecord(parsed)) {
    errors.push(`${manifestPath} is not a JSON object`);
    return result;
  }
  const manifest = parsed as unknown as PackageManifestValue;
  result.manifest = manifest;
  if (canonicalJson(manifest) !== manifestText) {
    errors.push(`${manifestPath} is not in canonical form`);
  }
  if (isProject) {
    validateProjectManifest(manifest as ProjectPackageManifest, errors);
  } else {
    validateArtifactManifest(manifest as PackageManifest, errors);
  }

  let sumsBytes: Uint8Array;
  try {
    sumsBytes = await inflateCapped(sumsEntry, PACKAGE_LIMITS.maxSumsBytes, budget, sumsPath);
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : `${sumsPath} could not be decompressed`);
    return result;
  }
  const sums = parseSums(new TextDecoder('utf-8', { fatal: true }).decode(sumsBytes), errors);
  result.sums = sums;
  const sumFor = new Map(sums.map((entry) => [entry.path, entry.sha256]));

  if (sumFor.get(manifestPath) !== result.manifestHash) {
    errors.push(`${sumsPath} does not list the archive's ${manifestPath} hash`);
  }

  const manifestFiles = new Map<string, { sha256: string; byteLength: number }>();
  const manifestList = Array.isArray(manifest.files) ? (manifest.files as unknown[]) : [];
  for (const raw of manifestList) {
    if (!isRecord(raw) || typeof raw.path !== 'string') continue;
    if (manifestFiles.has(raw.path)) continue;
    manifestFiles.set(raw.path, {
      sha256: String(raw.sha256),
      byteLength: Number(raw.byteLength),
    });
  }

  const archiveFiles = new Set(archiveNames.filter((name) => !zip.files[name].dir));
  const expectedSums = new Set([manifestPath, ...manifestFiles.keys()]);
  for (const entry of sums) {
    if (!expectedSums.has(entry.path)) {
      errors.push(`${sumsPath} lists an unexpected file: ${entry.path}`);
    }
  }
  for (const path of expectedSums) {
    if (!sumFor.has(path)) errors.push(`${sumsPath} does not cover ${path}`);
  }
  for (const name of archiveFiles) {
    if (name === sumsPath) continue;
    if (!expectedSums.has(name)) errors.push(`The archive holds an unlisted file: ${JSON.stringify(name)}`);
  }

  for (const [path, file] of manifestFiles) {
    const entry = zip.file(path);
    if (!entry) {
      errors.push(`The archive is missing ${path}`);
      continue;
    }
    let entryBytes: Uint8Array;
    try {
      entryBytes = await inflateCapped(entry, PACKAGE_LIMITS.maxEntryBytes, budget, path);
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : `${path} could not be decompressed`);
      break;
    }
    const digest = await sha256Hex(entryBytes);
    result.files.push({ path, byteLength: entryBytes.byteLength, sha256: digest });
    if (entryBytes.byteLength !== file.byteLength) {
      errors.push(`${path} length ${entryBytes.byteLength} does not match the manifest (${file.byteLength})`);
    }
    if (digest !== file.sha256) errors.push(`${path} hash does not match the manifest`);
    if (sumFor.get(path) !== digest) errors.push(`${path} hash does not match ${sumsPath}`);
  }

  if (isProject) {
    await verifyNestedPackages(zip, manifest as ProjectPackageManifest, errors);
  }

  warnings.push(
    'contentDigest and revisionHash are recorded, not recomputed: the manifest keeps the exported entry names, not the stored originals.',
  );

  result.ok = errors.length === 0;
  return result;
}

async function verifyNestedPackages(
  zip: JSZip,
  manifest: ProjectPackageManifest,
  errors: string[],
): Promise<void> {
  if (!Array.isArray(manifest.artifacts)) return;
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact) || typeof artifact.packageManifestPath !== 'string') continue;
    const entry = zip.file(artifact.packageManifestPath);
    if (!entry) {
      errors.push(`The project archive is missing ${artifact.packageManifestPath}`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await inflateCapped(
        entry,
        PACKAGE_LIMITS.maxManifestBytes,
        { total: 0 },
        artifact.packageManifestPath,
      );
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : `${artifact.packageManifestPath} could not be decompressed`);
      continue;
    }
    const digest = await sha256Hex(bytes);
    if (digest !== artifact.packageManifestHash) {
      errors.push(`${artifact.packageManifestPath} hash does not match the project manifest`);
    }
    let inner: PackageManifest;
    try {
      inner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as PackageManifest;
    } catch {
      errors.push(`${artifact.packageManifestPath} is not valid JSON`);
      continue;
    }
    if (!isRecord(inner)) {
      errors.push(`${artifact.packageManifestPath} is not a JSON object`);
      continue;
    }
    const innerErrors: string[] = [];
    validateArtifactManifest(inner, innerErrors);
    if (inner.artifact?.artifactId !== artifact.artifactId) {
      innerErrors.push(`${artifact.packageManifestPath} names a different artifact`);
    }
    errors.push(...innerErrors.map((message) => `${artifact.packageManifestPath}: ${message}`));
    const dir = artifact.packageManifestPath.replace(/\/[^/]+$/, '');
    const innerFiles = new Set<string>([
      artifact.packageManifestPath,
      `${dir}/${PACKAGE_SUMS_FILE}`,
      ...(Array.isArray(inner.files) ? inner.files.map((file) => `${dir}/${file.path}`) : []),
    ]);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      if (!name.startsWith(`${dir}/`)) continue;
      if (!innerFiles.has(name)) errors.push(`The archive holds an unlisted file: ${JSON.stringify(name)}`);
    }
    for (const innerPath of innerFiles) {
      if (!zip.file(innerPath)) errors.push(`The archive is missing ${innerPath}`);
    }
  }
}
