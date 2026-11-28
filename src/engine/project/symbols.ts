import type { ParsedModule } from '../parser/types';
import { signatureOf } from '../parser';
import type {
  ProjectFile,
  ProjectSymbol,
  ProjectSymbolTable,
  ProjectSymbolKind,
  ResolutionStatus,
  ResolvedReference,
  SymbolReference,
} from './types';

/** Symbol table and reference resolution across a project (WO-E03). */

const PRIMITIVES = new Set([
  'void', 'int', 'long', 'short', 'char', 'float', 'double', 'bool', 'boolean', 'string', 'number',
  'unknown', 'any', 'never', 'object', 'byte', 'uint', 'ulong', 'ushort', 'sbyte', 'decimal',
  'dynamic', 'var', 'auto', 'size_t', 'nullptr', 'nil', 'true', 'false', 'this', 'self', 'new',
  'const', 'unsigned', 'signed', 'volatile', 'String', 'Boolean', 'Integer', 'Double', 'Float',
  'Long', 'Object', 'Array', 'Map', 'Set', 'List', 'Dictionary', 'Task', 'Promise', 'Record',
  'Partial', 'Readonly', 'Optional', 'ReadonlyArray', 'Iterable', 'Iterator', 'Error',
]);

function symbolId(filePath: string, kind: ProjectSymbolKind, name: string, owner: string | undefined, line: number): string {
  return `${filePath}#${kind}:${owner ? `${owner}.` : ''}${name}@${line}`;
}

function typeNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const names: string[] = [];
  const re = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const name = match[0];
    if (PRIMITIVES.has(name.split('.').pop() ?? name)) continue;
    if (name.includes('<')) continue;
    names.push(name);
  }
  return names;
}

export function extractSymbols(file: ProjectFile, module: ParsedModule): {
  symbols: ProjectSymbol[];
  references: SymbolReference[];
} {
  const symbols: ProjectSymbol[] = [];
  const references: SymbolReference[] = [];
  const seen = new Set<string>();
  const push = (symbol: ProjectSymbol) => {
    if (seen.has(symbol.id)) return;
    seen.add(symbol.id);
    symbols.push(symbol);
  };

  for (const fn of module.functions) {
    const id = symbolId(file.path, fn.isMethod ? 'method' : 'function', fn.name, fn.className, fn.startLine);
    push({
      id,
      name: fn.name,
      kind: fn.isMethod ? 'method' : 'function',
      language: file.language,
      filePath: file.path,
      line: fn.startLine,
      endLine: fn.endLine,
      owner: fn.className,
      exported: fn.exported,
      signature: signatureOf(fn),
    });
    for (const call of fn.calls) {
      const tail = call.split('.').pop() ?? call;
      const start = Math.max(0, fn.startLine - 1);
      const end = Math.min(module.lines.length, fn.endLine);
      let line = fn.startLine;
      const needle = new RegExp(`\\b${tail.replace(/[$]/g, '\\$&')}\\s*\\(`);
      for (let index = start; index < end; index += 1) {
        if (needle.test(module.lines[index])) {
          line = index + 1;
          break;
        }
      }
      references.push({ name: call, kind: 'call', filePath: file.path, line, fromSymbolId: id });
    }
    for (const name of [
      ...typeNames(fn.returnType),
      ...fn.params.flatMap((param) => typeNames(param.type)),
    ]) {
      references.push({ name, kind: 'type', filePath: file.path, line: fn.startLine, fromSymbolId: id });
    }
  }

  for (const type of module.types) {
    const id = symbolId(file.path, 'type', type.name, undefined, type.startLine);
    push({
      id,
      name: type.name,
      kind: 'type',
      language: file.language,
      filePath: file.path,
      line: type.startLine,
      endLine: type.endLine,
      exported: type.exported,
    });
    for (const name of [
      ...typeNames(type.extends),
      ...(type.implements ?? []).flatMap((entry) => typeNames(entry)),
      ...typeNames(type.aliasBody),
      ...type.members.flatMap((member) => typeNames(member.type)),
    ]) {
      references.push({ name, kind: 'type', filePath: file.path, line: type.startLine, fromSymbolId: id });
    }
    for (const member of type.members) {
      push({
        id: symbolId(file.path, 'member', member.name, type.name, member.line),
        name: member.name,
        kind: 'member',
        language: file.language,
        filePath: file.path,
        line: member.line,
        owner: type.name,
        exported: type.exported,
      });
    }
  }

  for (const global of module.globals) {
    push({
      id: symbolId(file.path, 'global', global.name, undefined, global.line),
      name: global.name,
      kind: 'global',
      language: file.language,
      filePath: file.path,
      line: global.line,
      exported: true,
    });
    for (const name of typeNames(global.type)) {
      references.push({ name, kind: 'type', filePath: file.path, line: global.line });
    }
  }

  return { symbols, references };
}

const CALLABLE: ProjectSymbolKind[] = ['function', 'method'];

function resolveOne(
  reference: SymbolReference,
  byName: Map<string, ProjectSymbol[]>,
  importNames: Set<string>,
): ResolvedReference {
  const tail = reference.name.split(/[.]/).pop() ?? reference.name;
  const candidates = (byName.get(tail) ?? []).filter((symbol) =>
    reference.kind === 'call' ? CALLABLE.includes(symbol.kind) : symbol.kind === 'type',
  );
  const sameFile = candidates.filter((symbol) => symbol.filePath === reference.filePath);
  if (sameFile.length) {
    return { ...reference, status: 'resolved', targets: sameFile.map((symbol) => symbol.id) };
  }
  const exported = candidates.filter((symbol) => symbol.exported);
  if (exported.length === 1) {
    return { ...reference, status: 'resolved', targets: [exported[0].id] };
  }
  if (exported.length > 1) {
    return { ...reference, status: 'ambiguous', targets: exported.map((symbol) => symbol.id) };
  }
  if (importNames.has(reference.name) || importNames.has(tail)) {
    return { ...reference, status: 'external', targets: [] };
  }
  return { ...reference, status: 'unresolved', targets: [] };
}

export function buildSymbolTable(
  analyses: { file: ProjectFile; module: ParsedModule; symbols: ProjectSymbol[]; references: SymbolReference[] }[],
): ProjectSymbolTable {
  const symbols = analyses.flatMap((analysis) => analysis.symbols);
  const references = analyses.flatMap((analysis) => analysis.references);
  const byName = new Map<string, ProjectSymbol[]>();
  for (const symbol of symbols) {
    const list = byName.get(symbol.name);
    if (list) list.push(symbol);
    else byName.set(symbol.name, [symbol]);
  }
  const importsByFile = new Map<string, Set<string>>();
  for (const analysis of analyses) {
    const names = new Set<string>();
    for (const imported of analysis.module.imports) {
      for (const name of imported.names) if (name) names.add(name);
      names.add(imported.module);
      names.add(imported.module.split(/[./\\]/).pop() ?? imported.module);
    }
    importsByFile.set(analysis.file.path, names);
  }
  const resolutions = references.map((reference) =>
    resolveOne(reference, byName, importsByFile.get(reference.filePath) ?? new Set<string>()),
  );
  const counts: Record<ResolutionStatus, number> = {
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    external: 0,
  };
  for (const resolution of resolutions) counts[resolution.status] += 1;
  return { symbols, resolutions, counts };
}
