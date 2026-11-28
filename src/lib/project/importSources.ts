import JSZip from 'jszip';
import { detectLanguage, extensionOf } from '../../engine/parser';
import { normaliseProjectPath } from '../../engine/project/dependencies';
import type { ProjectFile, ProjectSkippedFile, ProjectSourceSet } from '../../engine/project/types';
import { sha256Hex } from '../artifacts/hash';
import { inflateCapped, type ExtractionBudget } from '../artifacts/import';

/** Multi-file / folder / ZIP import with hard limits (WO-E01). */

export const PROJECT_IMPORT_LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxZipEntries: 4000,
} as const;

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyw', 'java', 'go',
  'c', 'h', 'cc', 'cpp', 'cxx', 'c++', 'hpp', 'hh', 'hxx',
  'cs', 'csx',
  'json', 'md', 'txt', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'xml', 'html', 'css', 'scss',
  'sql', 'sh', 'ps1', 'cmake', 'gradle', 'properties',
]);

const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'cmakelists.txt', 'gemfile', 'rakefile',
]);

export function isSupportedProjectPath(path: string): boolean {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (TEXT_FILENAMES.has(name)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

/** Rejects traversal, absolute and NUL-bearing paths before anything is read. */
export function safeProjectPath(path: string): string {
  if (!path || /[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) throw new Error('Unsafe project path');
  if (/^[A-Za-z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Unsafe project path: ${path}`);
  }
  const segments = path.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) throw new Error(`Unsafe project path: ${path}`);
  const normalised = normaliseProjectPath(path);
  if (!normalised) throw new Error(`Unsafe project path: ${path}`);
  return normalised;
}

export interface ProjectTextInput {
  path: string;
  text: string;
}

/** Hashes and types already-decoded texts; enforces the per-file and total caps. */
export async function projectFilesFromTexts(
  inputs: readonly ProjectTextInput[],
  skipped: ProjectSkippedFile[] = [],
): Promise<ProjectSourceSet> {
  const accepted: ProjectTextInput[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const input of inputs) {
    const path = safeProjectPath(input.path);
    if (!isSupportedProjectPath(path)) {
      skipped.push({ path, reason: 'unsupported file type' });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ path, reason: 'duplicate path' });
      continue;
    }
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > PROJECT_IMPORT_LIMITS.maxFileBytes) {
      skipped.push({ path, reason: `file exceeds ${PROJECT_IMPORT_LIMITS.maxFileBytes} bytes` });
      continue;
    }
    total += bytes.byteLength;
    if (total > PROJECT_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(`Project exceeds ${PROJECT_IMPORT_LIMITS.maxTotalBytes} bytes`);
    }
    if (accepted.length >= PROJECT_IMPORT_LIMITS.maxFiles) {
      throw new Error(`Project exceeds ${PROJECT_IMPORT_LIMITS.maxFiles} files`);
    }
    seen.add(path);
    accepted.push({ path, text: input.text });
  }
  const files: ProjectFile[] = await Promise.all(
    accepted.map(async (input) => {
      const bytes = new TextEncoder().encode(input.text);
      return {
        path: input.path,
        text: input.text,
        language: detectLanguage(input.path, input.text),
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      };
    }),
  );
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}

export interface ProjectFileLike {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Reads browser File objects (multi-select or folder picker). */
export async function readProjectFiles(
  selected: readonly ProjectFileLike[],
  skipped: ProjectSkippedFile[] = [],
): Promise<ProjectSourceSet> {
  if (selected.length > PROJECT_IMPORT_LIMITS.maxFiles) {
    throw new Error(`Project exceeds ${PROJECT_IMPORT_LIMITS.maxFiles} files`);
  }
  const texts: ProjectTextInput[] = [];
  let total = 0;
  for (const file of selected) {
    const rawPath = file.webkitRelativePath || file.name;
    const path = safeProjectPath(rawPath);
    if (!isSupportedProjectPath(path)) {
      skipped.push({ path, reason: 'unsupported file type' });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > PROJECT_IMPORT_LIMITS.maxFileBytes) {
      skipped.push({ path, reason: `file exceeds ${PROJECT_IMPORT_LIMITS.maxFileBytes} bytes` });
      continue;
    }
    total += bytes.byteLength;
    if (total > PROJECT_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(`Project exceeds ${PROJECT_IMPORT_LIMITS.maxTotalBytes} bytes`);
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      skipped.push({ path, reason: 'not UTF-8 text' });
      continue;
    }
    texts.push({ path, text });
  }
  return projectFilesFromTexts(texts, skipped);
}

/**
 * Reads a project ZIP through the same streaming caps as the artifact
 * verifier: entries are inflated with a per-file and a run-total budget, and
 * an unsafe path aborts the whole archive.
 */
export async function readProjectZip(
  bytes: Uint8Array,
  limits: Pick<typeof PROJECT_IMPORT_LIMITS, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxZipEntries'> = PROJECT_IMPORT_LIMITS,
): Promise<ProjectSourceSet> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > limits.maxZipEntries) {
    throw new Error(`Archive exceeds ${limits.maxZipEntries} entries`);
  }
  const skipped: ProjectSkippedFile[] = [];
  const budget: ExtractionBudget = { total: 0, maxTotal: limits.maxTotalBytes };
  const texts: ProjectTextInput[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = safeProjectPath(entry.name);
    if (!isSupportedProjectPath(path)) {
      skipped.push({ path, reason: 'unsupported file type' });
      continue;
    }
    const data = await inflateCapped(entry, limits.maxFileBytes, budget, path);
    const text = decodeUtf8(data);
    if (text === null) {
      skipped.push({ path, reason: 'not UTF-8 text' });
      continue;
    }
    texts.push({ path, text });
  }
  return projectFilesFromTexts(texts, skipped);
}
