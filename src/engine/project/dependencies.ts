import type { ParsedModule } from '../parser/types';
import type {
  DependencyKind,
  ProjectCycle,
  ProjectDependencyEdge,
  ProjectDependencyGraph,
  ProjectFile,
} from './types';

/** Cross-file dependency graph, cycles and unresolved edges (WO-E04). */

const RESOLVE_EXTENSIONS = [
  '',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.cs',
  '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.cc', '.cxx',
];

const INDEX_FILES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.py', 'index.go', 'index.java',
];

export function normaliseProjectPath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function dependencyKind(kind: ProjectModuleImportKind): DependencyKind {
  return kind === 'include' ? 'includes' : kind === 'using' ? 'using' : 'imports';
}

type ProjectModuleImportKind = ParsedModule['imports'][number]['kind'];

function candidatePaths(fromPath: string, specifier: string, language: ProjectFile['language']): string[] {
  const relative = specifier.startsWith('.') || specifier.startsWith('/');
  const bases: string[] = [];
  if (relative) {
    bases.push(normaliseProjectPath(`${dirname(fromPath)}/${specifier}`));
  } else if (language === 'csharp') {
    const dotted = specifier.replace(/\./g, '/');
    bases.push(dotted);
  } else {
    bases.push(specifier);
  }
  const candidates: string[] = [];
  for (const base of bases) {
    for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const index of INDEX_FILES) candidates.push(`${base}/${index}`);
  }
  return candidates;
}

function resolveSpecifier(
  fromPath: string,
  specifier: string,
  language: ProjectFile['language'],
  files: Map<string, ProjectFile>,
): string | null {
  const candidates = candidatePaths(fromPath, specifier, language);
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  // Include directories and dotted namespaces usually arrive as a suffix.
  const suffixes = candidates.map((candidate) => `/${candidate}`);
  const ordered = [...files.keys()].sort();
  for (const suffix of suffixes) {
    const hit = ordered.find((path) => path.endsWith(suffix));
    if (hit) return hit;
  }
  return null;
}

function addEdge(
  edges: ProjectDependencyEdge[],
  analysis: { file: ProjectFile; module: ParsedModule },
  files: Map<string, ProjectFile>,
): void {
  for (const imported of analysis.module.imports) {
    const specifier = imported.module;
    if (!specifier) continue;
    if (imported.external) {
      edges.push({
        from: analysis.file.path,
        to: null,
        specifier,
        line: imported.line,
        kind: dependencyKind(imported.kind),
        status: 'external',
      });
      continue;
    }
    const target = resolveSpecifier(analysis.file.path, specifier, analysis.file.language, files);
    edges.push({
      from: analysis.file.path,
      to: target,
      specifier,
      line: imported.line,
      kind: dependencyKind(imported.kind),
      status: target ? 'resolved' : 'unresolved',
    });
  }
}

/** Tarjan SCC; a cycle is any component of size > 1 or a self-edge. */
function findCycles(nodes: string[], adjacency: Map<string, string[]>): ProjectCycle[] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: ProjectCycle[] = [];

  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let current: string;
      do {
        current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      const selfLoop = component.length === 1 && (adjacency.get(component[0]) ?? []).includes(component[0]);
      if (component.length > 1 || selfLoop) cycles.push({ files: component.sort() });
    }
  };

  for (const node of [...nodes].sort()) if (!index.has(node)) visit(node);
  return cycles.sort((a, b) => a.files[0].localeCompare(b.files[0]));
}

export function buildDependencyGraph(
  analyses: { file: ProjectFile; module: ParsedModule }[],
  projectFiles: ProjectFile[],
): ProjectDependencyGraph {
  const files = new Map(projectFiles.map((file) => [file.path, file]));
  const edges: ProjectDependencyEdge[] = [];
  for (const analysis of analyses) addEdge(edges, analysis, files);
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.specifier.localeCompare(b.specifier));

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.status !== 'resolved' || !edge.to) continue;
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  for (const list of adjacency.values()) list.sort();

  return {
    edges,
    cycles: findCycles(
      projectFiles.map((file) => file.path),
      adjacency,
    ),
    unresolved: edges
      .filter((edge) => edge.status === 'unresolved')
      .map((edge) => ({ from: edge.from, specifier: edge.specifier, line: edge.line })),
  };
}
