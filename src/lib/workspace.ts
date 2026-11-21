/**
 * PC workspace rail model.
 *
 * The rail is only rendered at `min-width: 1024px`. It reads a folder through
 * the File System Access API when the browser offers it and falls back to a
 * plain `<input type="file" webkitdirectory multiple>` everywhere else, so the
 * same tree builder serves both paths (and the unit tests).
 */

export const NOISY_DIRECTORIES = ['node_modules', '.git', 'dist', 'build', '.next'];

export interface WorkspaceFileMeta {
  /** Path relative to the picked folder, e.g. `src/tools/takane/adapter.ts`. */
  path: string;
  size?: number;
}

export interface WorkspaceDirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: WorkspaceNode[];
  /** Files in this subtree, noisy directories excluded. */
  fileCount: number;
}

export interface WorkspaceFileNode {
  kind: 'file';
  name: string;
  path: string;
  size?: number;
}

export type WorkspaceNode = WorkspaceDirNode | WorkspaceFileNode;

export function isNoisyPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment) => NOISY_DIRECTORIES.includes(segment));
}

/** Strips the folder prefix a directory picker may prepend (`my-repo/src/a.ts`). */
export function relativePath(path: string, root?: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!root) return clean;
  const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

interface MutableDir {
  kind: 'dir';
  name: string;
  path: string;
  children: Map<string, MutableDir | WorkspaceFileNode>;
}

function sortNodes(a: WorkspaceNode, b: WorkspaceNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

function finalise(dir: MutableDir): WorkspaceDirNode {
  const children: WorkspaceNode[] = [];
  let fileCount = 0;
  for (const child of dir.children.values()) {
    if (child.kind === 'dir') {
      const node = finalise(child);
      fileCount += node.fileCount;
      children.push(node);
    } else {
      fileCount += 1;
      children.push(child);
    }
  }
  children.sort(sortNodes);
  return { kind: 'dir', name: dir.name, path: dir.path, children, fileCount };
}

/**
 * Builds a sorted, collapsible tree from a flat file list.
 * Noisy directories (`node_modules`, `.git`, `dist`, `build`, `.next`) are
 * skipped before the tree is built so they never reach the UI.
 */
export function buildWorkspaceTree(
  files: WorkspaceFileMeta[],
  options: { root?: string; skipNoisy?: boolean } = {},
): WorkspaceNode[] {
  const skipNoisy = options.skipNoisy ?? true;
  const root: MutableDir = { kind: 'dir', name: '', path: '', children: new Map() };

  for (const file of files) {
    const path = relativePath(file.path, options.root);
    if (!path) continue;
    if (skipNoisy && isNoisyPath(path)) continue;
    const segments = path.split('/').filter(Boolean);
    if (!segments.length) continue;
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      const dirPath = segments.slice(0, index + 1).join('/');
      const existing = cursor.children.get(name);
      if (existing && existing.kind === 'dir') {
        cursor = existing;
      } else {
        const created: MutableDir = { kind: 'dir', name, path: dirPath, children: new Map() };
        cursor.children.set(name, created);
        cursor = created;
      }
    }
    const name = segments[segments.length - 1];
    cursor.children.set(name, { kind: 'file', name, path, size: file.size });
  }

  return finalise(root).children;
}

/** Case-insensitive substring filter; a directory stays when any descendant matches. */
export function filterWorkspaceTree(nodes: WorkspaceNode[], query: string): WorkspaceNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const result: WorkspaceNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (node.path.toLowerCase().includes(needle)) result.push(node);
      continue;
    }
    if (node.path.toLowerCase().includes(needle)) {
      result.push(node);
      continue;
    }
    const children = filterWorkspaceTree(node.children, needle);
    if (children.length) result.push({ ...node, children, fileCount: children.length });
  }
  return result;
}

export function flattenWorkspace(nodes: WorkspaceNode[]): WorkspaceFileNode[] {
  const files: WorkspaceFileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') files.push(node);
    else files.push(...flattenWorkspace(node.children));
  }
  return files;
}

export function countWorkspaceFiles(nodes: WorkspaceNode[]): number {
  return flattenWorkspace(nodes).length;
}

/** Default directories expanded when a tree first appears. */
export function defaultExpanded(nodes: WorkspaceNode[], depth = 1): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  const walk = (list: WorkspaceNode[], level: number) => {
    for (const node of list) {
      if (node.kind !== 'dir') continue;
      if (level < depth) expanded[node.path] = true;
      walk(node.children, level + 1);
    }
  };
  walk(nodes, 0);
  return expanded;
}

/**
 * Reads a folder through the File System Access API.
 * Returns `null` when the API is unavailable so the caller can fall back to the
 * `webkitdirectory` input.
 */
export async function pickDirectory(): Promise<{ name: string; files: { path: string; file: File }[] } | null> {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  const handle = await picker();
  const files: { path: string; file: File }[] = [];
  for await (const entry of (handle as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
    const path = entry.name;
    if (isNoisyPath(path)) continue;
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile();
      files.push({ path, file });
      continue;
    }
    const directory = entry as FileSystemDirectoryHandle;
    for await (const child of (directory as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
      const childPath = `${directory.name}/${child.name}`;
      if (isNoisyPath(childPath)) continue;
      if (child.kind === 'file') {
        files.push({ path: childPath, file: await (child as FileSystemFileHandle).getFile() });
        continue;
      }
      await walkHandle(child as FileSystemDirectoryHandle, childPath, files);
    }
  }
  return { name: handle.name, files };
}

async function walkHandle(
  handle: FileSystemDirectoryHandle,
  path: string,
  files: { path: string; file: File }[],
): Promise<void> {
  for await (const child of (handle as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()) {
    const childPath = `${path}/${child.name}`;
    if (isNoisyPath(childPath)) continue;
    if (child.kind === 'file') {
      files.push({ path: childPath, file: await (child as FileSystemFileHandle).getFile() });
      continue;
    }
    await walkHandle(child as FileSystemDirectoryHandle, childPath, files);
  }
}

/** Normalises a `webkitdirectory` selection into relative-path entries. */
export function filesFromInput(files: FileList | File[]): { root: string; files: { path: string; file: File }[] } {
  const list = [...files];
  const paths = list.map((file) => (file.webkitRelativePath || file.name).replace(/\\/g, '/'));
  const firstSegment = paths[0]?.split('/')[0] ?? '';
  const sharedRoot = paths.every((path) => path.split('/')[0] === firstSegment) ? firstSegment : '';
  const root = sharedRoot && list.length > 1 ? sharedRoot : '';
  return {
    root,
    files: list
      .map((file, index) => ({ path: paths[index], file }))
      .filter((entry) => !isNoisyPath(entry.path)),
  };
}
