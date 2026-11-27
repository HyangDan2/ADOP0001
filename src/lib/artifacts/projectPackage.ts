/**
 * G2-FIX-01 — project package.
 *
 * A project package aggregates selected artifacts of one workspace: each
 * artifact keeps its single-package output (built by `buildArtifactPackage`, so
 * the manifest/files/SHA-256 rules are identical), placed under
 * `project-artifacts/<type>/<artifactId>/`. The project manifest lists the
 * chosen revisions, their dependencies, requirement ids and each nested
 * package-manifest hash, and `project-artifacts/SHA256SUMS.txt` covers every
 * archived file including the project manifest. The revision's stored source
 * snapshot is added only when the caller opts in.
 */

import JSZip from 'jszip';
import { canonicalJson } from '../../engine/hybrid/canonical';
import { REQUIREMENT_CATALOGUE } from '../../engine/artifacts/traceability';
import type {
  ArtifactRecord,
  ArtifactRevision,
  ValidationRecord,
} from '../../engine/artifacts/types';
import { decodeContentPayload, sha256Hex } from './hash';
import {
  EXTENSION_BY_CONTENT_TYPE,
  PACKAGE_MANIFEST_FILE,
  buildArtifactPackage,
  sanitizeFileName,
  sha256SumsText,
} from './package';

export const PROJECT_PACKAGE_VERSION = 'adop0001.project-package.v1';
export const PROJECT_PACKAGE_DIR = 'project-artifacts';
export const PROJECT_PACKAGE_MANIFEST = `${PROJECT_PACKAGE_DIR}/manifest.json`;
export const PROJECT_PACKAGE_SUMS = `${PROJECT_PACKAGE_DIR}/SHA256SUMS.txt`;

const MAX_FILE_NAME_ATTEMPTS = 1000;

export interface ProjectArtifactInput {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  validation: ValidationRecord;
}

export interface ProjectPackageFile {
  path: string;
  sha256: string;
  byteLength: number;
  artifactId: string;
  role: 'package' | 'source';
}

export interface ProjectPackageArtifact {
  artifactId: string;
  artifactType: ArtifactRecord['artifactType'];
  toolId: ArtifactRecord['toolId'];
  documentSlotId?: string;
  revision: {
    revisionId: string;
    ordinal: number;
    contentDigest: string;
    revisionHash: string;
    createdAt: string;
  };
  validation: {
    recordId: string;
    status: ValidationRecord['status'];
  };
  dependencies: ArtifactRevision['dependencies'];
  requirements: string[];
  packageManifestPath: string;
  packageManifestHash: string;
}

export interface ProjectPackageManifest {
  manifestVersion: typeof PROJECT_PACKAGE_VERSION;
  format: 'zip';
  packagedAt: string;
  includeSource: boolean;
  artifacts: ProjectPackageArtifact[];
  requirements: string[];
  files: ProjectPackageFile[];
}

export interface ProjectPackageBuildResult {
  manifest: ProjectPackageManifest;
  manifestText: string;
  manifestHash: string;
  zipBytes: Uint8Array;
  zipHash: string;
  fileNameStem: string;
}

export interface BuildProjectPackageInput {
  artifacts: ProjectArtifactInput[];
  includeSource?: boolean;
  baseName?: string;
}

function requirementsFor(artifact: ArtifactRecord): string[] {
  return REQUIREMENT_CATALOGUE.filter(
    (requirement) =>
      requirement.artifactTypes.includes(artifact.artifactType) &&
      (requirement.id.startsWith('REQ-G2-') || requirement.toolId === artifact.toolId),
  ).map((requirement) => requirement.id);
}

function projectFileName(
  entry: ArtifactRevision['contents'][number],
  baseDir: string,
  used: Set<string>,
): string {
  const raw =
    entry.fileName ??
    `${entry.role}${entry.variant ? `-${entry.variant}` : ''}${EXTENSION_BY_CONTENT_TYPE[entry.contentType]}`;
  const cleaned = sanitizeFileName(raw);
  let candidate = cleaned;
  let index = 2;
  while (used.has(candidate) && index < MAX_FILE_NAME_ATTEMPTS) {
    const dot = cleaned.lastIndexOf('.');
    candidate = dot > 0 ? `${cleaned.slice(0, dot)}-${index}${cleaned.slice(dot)}` : `${cleaned}-${index}`;
    index += 1;
  }
  if (used.has(candidate)) throw new Error(`Could not name the source snapshot for ${baseDir}`);
  used.add(candidate);
  return candidate;
}

export async function buildProjectPackage(
  input: BuildProjectPackageInput,
): Promise<ProjectPackageBuildResult> {
  if (input.artifacts.length < 2) {
    throw new Error('プロジェクト書き出しには 2 件以上の成果物を選択してください。');
  }
  const includeSource = input.includeSource === true;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const manifestFiles: ProjectPackageFile[] = [];
  const manifestArtifacts: ProjectPackageArtifact[] = [];

  const ordered = [...input.artifacts].sort((a, b) =>
    a.artifact.artifactId < b.artifact.artifactId ? -1 : a.artifact.artifactId > b.artifact.artifactId ? 1 : 0,
  );

  for (const selected of ordered) {
    const { artifact, revision, validation } = selected;
    if (validation.validatedRevisionId !== revision.revisionId) {
      throw new Error(`${artifact.artifactType} の検証記録が選択リビジョンと一致しません。`);
    }
    const built = await buildArtifactPackage({
      artifact,
      revision,
      validation,
      baseName: artifact.artifactType,
    });
    const dir = `${PROJECT_PACKAGE_DIR}/${artifact.artifactType}/${artifact.artifactId}`;
    const inner = await JSZip.loadAsync(built.zipBytes);
    for (const [name, entry] of Object.entries(inner.files)) {
      if (entry.dir) continue;
      const bytes = await entry.async('uint8array');
      const path = `${dir}/${name}`;
      files.push({ path, bytes });
      manifestFiles.push({
        path,
        sha256: await sha256Hex(bytes),
        byteLength: bytes.byteLength,
        artifactId: artifact.artifactId,
        role: 'package',
      });
    }

    if (includeSource) {
      const sourceDir = `${PROJECT_PACKAGE_DIR}/source/${artifact.artifactType}/${artifact.artifactId}`;
      const used = new Set<string>();
      for (const entry of [...revision.contents].sort((a, b) => a.order - b.order)) {
        const bytes = decodeContentPayload(entry.encoding, entry.payload);
        const path = `${sourceDir}/${projectFileName(entry, sourceDir, used)}`;
        files.push({ path, bytes });
        manifestFiles.push({
          path,
          sha256: await sha256Hex(bytes),
          byteLength: bytes.byteLength,
          artifactId: artifact.artifactId,
          role: 'source',
        });
      }
    }

    manifestArtifacts.push({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      toolId: artifact.toolId,
      ...(artifact.documentSlotId === undefined ? {} : { documentSlotId: artifact.documentSlotId }),
      revision: {
        revisionId: revision.revisionId,
        ordinal: revision.ordinal,
        contentDigest: revision.contentDigest,
        revisionHash: revision.revisionHash,
        createdAt: revision.createdAt,
      },
      validation: { recordId: validation.recordId, status: validation.status },
      dependencies: revision.dependencies,
      requirements: requirementsFor(artifact),
      packageManifestPath: `${dir}/${PACKAGE_MANIFEST_FILE}`,
      packageManifestHash: built.manifestHash,
    });
  }

  manifestFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const requirements = [...new Set(manifestArtifacts.flatMap((item) => item.requirements))].sort();
  const packagedAt = ordered.reduce(
    (newest, item) => (item.revision.createdAt > newest ? item.revision.createdAt : newest),
    ordered[0].revision.createdAt,
  );

  const manifest: ProjectPackageManifest = {
    manifestVersion: PROJECT_PACKAGE_VERSION,
    format: 'zip',
    packagedAt,
    includeSource,
    artifacts: manifestArtifacts,
    requirements,
    files: manifestFiles,
  };
  const manifestText = canonicalJson(manifest);
  const manifestHash = await sha256Hex(new TextEncoder().encode(manifestText));
  const sumsText = sha256SumsText([
    ...manifestFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
    { path: PROJECT_PACKAGE_MANIFEST, sha256: manifestHash },
  ]);

  const date = new Date(packagedAt);
  const zipDate = Number.isNaN(date.getTime()) ? new Date('1980-01-01T00:00:00.000Z') : date;
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.bytes, { date: zipDate });
  zip.file(PROJECT_PACKAGE_MANIFEST, manifestText, { date: zipDate });
  zip.file(PROJECT_PACKAGE_SUMS, sumsText, { date: zipDate });
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
    fileNameStem: sanitizeFileName(input.baseName?.trim() || 'project'),
  };
}

export function projectPackageFileName(stem: string): string {
  return `${sanitizeFileName(stem.replace(/\.zip$/i, '') || 'project')}.zip`;
}
