/**
 * WO-D06 — manifest package.
 *
 * A package is built from one stored revision only. Every entry is decoded and
 * re-hashed before it enters the ZIP, the manifest lists each file's SHA-256 and
 * the revision/content identities it was built from, and the manifest itself is
 * hashed. The package bytes are then registered through the export guard like
 * any other export (format `package`, content type `application/zip`).
 */

import JSZip from 'jszip';
import { canonicalJson } from '../../engine/hybrid/canonical';
import { REQUIREMENT_CATALOGUE } from '../../engine/artifacts/traceability';
import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRecord,
  ArtifactRevision,
  ValidationRecord,
} from '../../engine/artifacts/types';
import { decodeContentPayload, sha256Hex } from './hash';

export const PACKAGE_MANIFEST_VERSION = 'adop0001.package.v1';
export const PACKAGE_MANIFEST_FILE = 'manifest.json';

const EXTENSION_BY_CONTENT_TYPE: Record<ArtifactContentType, string> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/x-mermaid': '.mmd',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'application/json': '.json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/zip': '.zip',
  'text/x-python': '.py',
  'text/x-typescript': '.ts',
  'text/x-java': '.java',
  'text/x-go': '.go',
  'text/x-c': '.c',
  'text/x-cpp': '.cpp',
};

export interface PackageFileEntry {
  path: string;
  contentId: string;
  order: number;
  role: ArtifactContentEntry['role'];
  variant?: string;
  contentType: ArtifactContentType;
  encoding: ArtifactContentEntry['encoding'];
  byteLength: number;
  sha256: string;
}

export interface PackageManifest {
  manifestVersion: typeof PACKAGE_MANIFEST_VERSION;
  format: 'zip';
  packagedAt: string;
  artifact: {
    artifactId: string;
    artifactType: ArtifactRecord['artifactType'];
    toolId: ArtifactRecord['toolId'];
    documentSlotId?: string;
    schemaVersion: string;
    descriptorVersion: string;
  };
  revision: {
    revisionId: string;
    ordinal: number;
    parentRevisionId: string | null;
    createdAt: string;
    contentDigest: string;
    revisionHash: string;
    restoredFromRevisionId?: string;
  };
  source: ArtifactRevision['sourceRevision'];
  provenance: ArtifactRevision['provenance'];
  dependencies: ArtifactRevision['dependencies'];
  requirements: string[];
  validation: {
    recordId: string;
    status: ValidationRecord['status'];
    validatedAt: string;
    policyVersion: string;
    policyFingerprint: string;
    requiredTotal: number;
    requiredPassed: number;
    results: Array<{
      validatorId: string;
      level: ValidationRecord['results'][number]['level'];
      requirement: ValidationRecord['results'][number]['requirement'];
      executionStatus: ValidationRecord['results'][number]['executionStatus'];
      severity: ValidationRecord['results'][number]['severity'];
    }>;
  } | null;
  files: PackageFileEntry[];
}

export interface PackageBuildResult {
  manifest: PackageManifest;
  manifestText: string;
  manifestHash: string;
  zipBytes: Uint8Array;
  zipHash: string;
  fileNameStem: string;
}

export interface BuildPackageInput {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  validation: ValidationRecord | null;
  /** Stem for entries that carry no file name; defaults to the artifact id. */
  baseName?: string;
}

const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]+/g;

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME, '-').replace(/^\.+/, '').trim();
  return cleaned || 'file';
}

function uniquePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const extension = dot > 0 ? candidate.slice(dot) : '';
  let index = 2;
  while (used.has(`${stem}-${index}${extension}`)) index += 1;
  const next = `${stem}-${index}${extension}`;
  used.add(next);
  return next;
}

function entryFileName(
  entry: ArtifactContentEntry,
  baseName: string,
): string {
  if (entry.fileName) return sanitizeFileName(entry.fileName);
  const suffix = entry.variant ? `-${entry.variant}` : '';
  const extension = EXTENSION_BY_CONTENT_TYPE[entry.contentType];
  return sanitizeFileName(`${baseName}-${entry.role}${suffix}${extension}`);
}

function requirementsFor(artifact: ArtifactRecord): string[] {
  return REQUIREMENT_CATALOGUE.filter(
    (requirement) =>
      requirement.artifactTypes.includes(artifact.artifactType) &&
      (requirement.id.startsWith('REQ-G2-') || requirement.toolId === artifact.toolId),
  ).map((requirement) => requirement.id);
}

function validationManifest(record: ValidationRecord | null): PackageManifest['validation'] {
  if (!record) return null;
  const required = record.results.filter((result) => result.requirement === 'REQUIRED');
  return {
    recordId: record.recordId,
    status: record.status,
    validatedAt: record.validatedAt,
    policyVersion: record.policyVersion,
    policyFingerprint: record.policyFingerprint,
    requiredTotal: required.length,
    requiredPassed: required.filter((result) => result.executionStatus === 'PASS').length,
    results: record.results.map((result) => ({
      validatorId: result.validatorId,
      level: result.level,
      requirement: result.requirement,
      executionStatus: result.executionStatus,
      severity: result.severity,
    })),
  };
}

export async function buildArtifactPackage(input: BuildPackageInput): Promise<PackageBuildResult> {
  const { artifact, revision, validation } = input;
  const stem = sanitizeFileName(input.baseName ?? artifact.artifactId);
  const used = new Set<string>([PACKAGE_MANIFEST_FILE]);
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const manifestFiles: PackageFileEntry[] = [];

  for (const entry of [...revision.contents].sort((a, b) => a.order - b.order)) {
    const bytes = decodeContentPayload(entry.encoding, entry.payload);
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`Content ${entry.contentId} length does not match the stored entry`);
    }
    const digest = await sha256Hex(bytes);
    if (digest !== entry.contentHash) {
      throw new Error(`Content ${entry.contentId} hash does not match the stored entry`);
    }
    const path = uniquePath(entryFileName(entry, stem), used);
    files.push({ path, bytes });
    manifestFiles.push({
      path,
      contentId: entry.contentId,
      order: entry.order,
      role: entry.role,
      ...(entry.variant === undefined ? {} : { variant: entry.variant }),
      contentType: entry.contentType,
      encoding: entry.encoding,
      byteLength: entry.byteLength,
      sha256: entry.contentHash,
    });
  }

  const manifest: PackageManifest = {
    manifestVersion: PACKAGE_MANIFEST_VERSION,
    format: 'zip',
    packagedAt: revision.createdAt,
    artifact: {
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      toolId: artifact.toolId,
      ...(artifact.documentSlotId === undefined ? {} : { documentSlotId: artifact.documentSlotId }),
      schemaVersion: artifact.schemaVersion,
      descriptorVersion: artifact.descriptorVersion,
    },
    revision: {
      revisionId: revision.revisionId,
      ordinal: revision.ordinal,
      parentRevisionId: revision.parentRevisionId,
      createdAt: revision.createdAt,
      contentDigest: revision.contentDigest,
      revisionHash: revision.revisionHash,
      ...(revision.restoredFromRevisionId === undefined
        ? {}
        : { restoredFromRevisionId: revision.restoredFromRevisionId }),
    },
    source: revision.sourceRevision,
    provenance: revision.provenance,
    dependencies: revision.dependencies,
    requirements: requirementsFor(artifact),
    validation: validationManifest(validation),
    files: manifestFiles,
  };

  const manifestText = canonicalJson(manifest);
  const manifestHash = await sha256Hex(new TextEncoder().encode(manifestText));
  const date = new Date(revision.createdAt);
  const zipDate = Number.isNaN(date.getTime()) ? new Date('1980-01-01T00:00:00.000Z') : date;
  const zip = new JSZip();
  zip.file(PACKAGE_MANIFEST_FILE, manifestText, { date: zipDate });
  for (const file of files) zip.file(file.path, file.bytes, { date: zipDate });
  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  return {
    manifest,
    manifestText,
    manifestHash,
    zipBytes,
    zipHash: await sha256Hex(zipBytes),
    fileNameStem: stem,
  };
}

export function packageFileName(base: string): string {
  const trimmed = base.trim().replace(/\.zip$/i, '');
  return `${sanitizeFileName(trimmed || 'artifact')}.zip`;
}
