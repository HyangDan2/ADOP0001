import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceTree,
  countWorkspaceFiles,
  defaultExpanded,
  filesFromInput,
  filterWorkspaceTree,
  flattenWorkspace,
  isNoisyPath,
  relativePath,
  type WorkspaceDirNode,
} from '../src/lib/workspace';
import { extensionOf, isBinaryFile, isCodeFile, isDocxFile, isSpecFile, languageTagFor, targetToolForFile } from '../src/lib/fileKinds';

const FILES = [
  { path: 'my-repo/src/tools/takane/adapter.ts', size: 4000 },
  { path: 'my-repo/src/tools/takane/TakaneTool.tsx', size: 3000 },
  { path: 'my-repo/src/app.ts', size: 1200 },
  { path: 'my-repo/README.md', size: 900 },
  { path: 'my-repo/node_modules/react/index.js', size: 10 },
  { path: 'my-repo/.git/config', size: 10 },
  { path: 'my-repo/dist/app.js', size: 10 },
  { path: 'my-repo/build/out.js', size: 10 },
];

describe('workspace tree builder', () => {
  it('nests files into a sorted directory tree', () => {
    const tree = buildWorkspaceTree(FILES, { root: 'my-repo' });
    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);
    const src = tree[0] as WorkspaceDirNode;
    expect(src.children.map((child) => child.name)).toEqual(['tools', 'app.ts']);
    const tools = src.children[0] as WorkspaceDirNode;
    expect(tools.children.map((child) => child.name)).toEqual(['takane']);
    expect(countWorkspaceFiles(tree)).toBe(4);
  });

  it('skips noisy directories and reports their file counts', () => {
    const tree = buildWorkspaceTree(FILES, { root: 'my-repo' });
    expect(flattenWorkspace(tree).map((file) => file.path)).not.toContain('node_modules/react/index.js');
    expect(flattenWorkspace(tree)).toHaveLength(4);
    const src = tree.find((node) => node.name === 'src') as WorkspaceDirNode;
    expect(src.fileCount).toBe(3);
    expect(src.children[0]).toMatchObject({ kind: 'dir', name: 'tools', fileCount: 2 });
  });

  it('keeps noisy directories when asked to', () => {
    const tree = buildWorkspaceTree(FILES, { skipNoisy: false });
    expect(countWorkspaceFiles(tree)).toBe(8);
  });

  it('strips the folder prefix from picker paths', () => {
    expect(relativePath('my-repo/src/app.ts', 'my-repo')).toBe('src/app.ts');
    expect(relativePath('./src/app.ts')).toBe('src/app.ts');
    expect(relativePath('src/app.ts', 'other')).toBe('src/app.ts');
    expect(isNoisyPath('a/node_modules/b.js')).toBe(true);
    expect(isNoisyPath('a/src/b.js')).toBe(false);
  });

  it('filters by name and keeps the ancestors of a match', () => {
    const tree = buildWorkspaceTree(FILES, { root: 'my-repo' });
    const filtered = filterWorkspaceTree(tree, 'tool');
    expect(flattenWorkspace(filtered).map((file) => file.name)).toEqual(['adapter.ts', 'TakaneTool.tsx']);
    expect(filtered[0].name).toBe('src');

    expect(filterWorkspaceTree(tree, 'README').flatMap((node) => flattenWorkspace([node]))).toHaveLength(1);
    expect(flattenWorkspace(filterWorkspaceTree(tree, 'nothing-here'))).toHaveLength(0);
    expect(filterWorkspaceTree(tree, '   ')).toBe(tree);
  });

  it('counts the filtered files under a directory, not its child entries (UI-002)', () => {
    const tree = buildWorkspaceTree(FILES, { root: 'my-repo' });
    const filtered = filterWorkspaceTree(tree, 'adapter');
    const src = filtered.find((node) => node.name === 'src') as WorkspaceDirNode;
    expect(src.fileCount).toBe(1);
    const tools = src.children.find((child) => child.name === 'tools') as WorkspaceDirNode;
    expect(tools.fileCount).toBe(1);
    const takane = tools.children[0] as WorkspaceDirNode;
    // One matching file, while the directory still has a sibling entry in the tree.
    expect(takane.children).toHaveLength(1);
    expect(takane.fileCount).toBe(1);
    for (const node of [src, tools, takane]) {
      expect(node.fileCount).toBe(flattenWorkspace([node]).length);
    }

    // A deeper tree keeps the count recursive: two files live under src/tools/takane.
    const deeper = filterWorkspaceTree(tree, 'takane/');
    const deepSrc = deeper.find((node) => node.name === 'src') as WorkspaceDirNode;
    expect(deepSrc.fileCount).toBe(flattenWorkspace([deepSrc]).length);
  });

  it('expands the first level by default', () => {
    const tree = buildWorkspaceTree(FILES, { root: 'my-repo' });
    const expanded = defaultExpanded(tree, 1);
    expect(expanded['src']).toBe(true);
    expect(expanded['src/tools']).toBeUndefined();
  });

  it('normalises a webkitdirectory selection', () => {
    const fakeFiles = [
      Object.assign(new File(['a'], 'adapter.ts'), { webkitRelativePath: 'proj/src/adapter.ts' }),
      Object.assign(new File(['b'], 'index.js'), { webkitRelativePath: 'proj/node_modules/x.js' }),
    ];
    const { root, files } = filesFromInput(fakeFiles);
    expect(root).toBe('proj');
    expect(files.map((entry) => entry.path)).toEqual(['proj/src/adapter.ts']);
  });
});

describe('file kinds and tool routing', () => {
  it('recognises code, spec and document files', () => {
    expect(extensionOf('src/App.TSX')).toBe('tsx');
    expect(isCodeFile('emitter.cpp')).toBe(true);
    expect(isCodeFile('main.ino')).toBe(true);
    expect(isSpecFile('payment-service.spec.md')).toBe(true);
    expect(isDocxFile('contract.docx')).toBe(true);
    expect(isBinaryFile('contract.docx')).toBe(true);
    expect(isBinaryFile('emitter.c')).toBe(false);
  });

  it('tags a few-shot language from the extension', () => {
    expect(languageTagFor('emitter.py')).toBe('python');
    expect(languageTagFor('emitter.c')).toBe('c');
    expect(languageTagFor('emitter.hpp')).toBe('cpp');
    expect(languageTagFor('sketch.ino')).toBe('mcu');
    expect(languageTagFor('notes.txt')).toBeUndefined();
  });

  it('routes a workspace file to the tool that can read it', () => {
    expect(targetToolForFile('spec.md', 'takane')).toBe('takane');
    expect(targetToolForFile('spec.md', 'shiori')).toBe('takane');
    expect(targetToolForFile('contract.docx', 'takane')).toBe('kotoha');
    expect(targetToolForFile('app.ts', 'yayoi')).toBe('yayoi');
    expect(targetToolForFile('app.ts', 'takane')).toBe('shiori');
  });
});
