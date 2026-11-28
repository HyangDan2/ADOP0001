import type { Lang, MemberInfo, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import {
  appendDiagnostic,
  blockEnd,
  braceColumn,
  findMatching,
  finishFunction,
  memberBodyLines,
  parseParamList,
  readDeclaration,
} from './normalizer';

/**
 * C / C++ / C# structural parser (WO-E02).
 *
 * Heuristic like the other parsers: declarations that cannot be read with the
 * brace rules are reported through diagnostics rather than dropped silently.
 * Namespaces are flattened; nested types keep their innermost owner.
 */

type Dialect = 'c' | 'cpp' | 'csharp';

const CONTROL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'delete', 'new', 'throw', 'do',
  'else', 'case', 'default', 'using', 'namespace', 'typedef', 'template', 'static_assert',
  'decltype', 'alignof', 'noexcept', 'operator',
]);

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'async', 'virtual', 'override', 'sealed',
  'abstract', 'partial', 'extern', 'unsafe', 'readonly', 'inline', 'constexpr', 'explicit', 'friend',
  'const', 'volatile', 'register', 'signed', 'unsigned', 'thread_local', 'mutable',
]);

const TYPE_WORDS = new Set([
  'class', 'struct', 'enum', 'interface', 'union', 'record', 'void', 'int', 'long', 'short', 'char',
  'float', 'double', 'bool', 'auto', 'var', 'string', 'size_t', 'bool', 'byte', 'decimal', 'object',
]);

interface TypeRange {
  name: string;
  start: number;
  end: number;
}

interface Callable {
  name: string;
  className?: string;
  params: string;
  returnType?: string;
  modifiers: string[];
  async: boolean;
  bodyLine: number;
}

/** Reads `ret name(params) qualifiers {` from a declaration header. */
function readCallable(headerText: string, dialect: Dialect, enclosing?: TypeRange): Callable | null {
  const text = headerText.replace(/\s*\{\s*$/, '').trim();
  if (!text || text.endsWith(';') || text.startsWith('#')) return null;
  if (text.includes('=>')) return null;
  const open = text.indexOf('(');
  if (open < 0) return null;
  const close = findMatching(text, open, '(', ')');
  if (close < 0) return null;
  const before = text.slice(0, open).trim();
  const nameMatch = before.match(/([~A-Za-z_]\w*(?:::[~A-Za-z_]\w*)*)\s*(?:<[^<>]*>)?$/);
  if (!nameMatch) return null;
  const qualified = nameMatch[1];
  const name = qualified.split('::').pop()!;
  if (CONTROL.has(name) || TYPE_WORDS.has(name)) return null;
  const prefix = before.slice(0, nameMatch.index).trim();
  const words = prefix.split(/\s+/).filter(Boolean);
  const modifiers = words.filter((word) => MODIFIERS.has(word));
  const qualifier = qualified.includes('::') ? qualified.slice(0, qualified.lastIndexOf('::')) : '';
  const returnType = words.filter((word) => !MODIFIERS.has(word)).join(' ').replace(/\s+/g, ' ').trim();
  const constructor = dialect === 'csharp' && !returnType && Boolean(enclosing) && enclosing!.name === name;
  if (dialect === 'c' && !returnType) return null;
  if (!returnType && !constructor && !qualifier) return null;
  return {
    name,
    className: qualifier || enclosing?.name,
    params: text.slice(open + 1, close),
    returnType: constructor ? undefined : returnType || undefined,
    modifiers,
    async: modifiers.includes('async'),
    bodyLine: -1,
  };
}

function readMembers(
  code: string[],
  start: number,
  end: number,
): MemberInfo[] {
  const members: MemberInfo[] = [];
  for (let i = start; i < end; i += 1) {
    const text = code[i].trim();
    if (!text || text.startsWith('#') || text.includes('(')) continue;
    if (/^(public|private|protected|internal|static|readonly|const|volatile|mutable)\s*:\s*$/.test(text)) continue;
    if (/\b(class|struct|enum|interface|union|namespace|using|typedef)\b/.test(text)) continue;
    const property = text.match(
      /^(?:(?:public|private|protected|internal|static|readonly|virtual|override|required)\s+)*([\w<>[\],.?]+)\s+(\w+)\s*\{\s*(?:get|set|init)/,
    );
    if (property) {
      members.push({ name: property[2], type: property[1], optional: false, line: i + 1 });
      continue;
    }
    const field = text.match(
      /^(?:(?:public|private|protected|internal|static|readonly|const|volatile|mutable|unsigned|signed)\s+)*([\w<>[\],.:*&]+(?:\s+[\w<>[\],.:*&]+)*)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;?$/,
    );
    if (field) {
      const type = field[1].trim();
      if (MODIFIERS.has(type)) continue;
      members.push({ name: field[2], type, optional: false, line: i + 1 });
    }
  }
  return members;
}

export function parseCFamily(
  module: ParsedModule,
  mask: Masked,
  diagnostics: SourceDiagnostic[],
  dialect: Dialect,
): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const lang: Lang = dialect;
  const types: TypeRange[] = [];

  for (let i = 0; i < code.length; i += 1) {
    const line = code[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (dialect !== 'csharp') {
      const include = lines[i].trim().match(/^#\s*include\s*([<"])([^>"]+)[>"]/);
      if (include) {
        module.imports.push({
          module: include[2],
          names: [include[2].split('/').pop() ?? include[2]],
          line: i + 1,
          external: include[1] === '<',
          kind: 'include',
        });
        continue;
      }
      if (trimmed.startsWith('#')) continue;
      const usingNamespace = trimmed.match(/^using\s+namespace\s+([\w:]+)\s*;/);
      if (usingNamespace) {
        module.imports.push({
          module: usingNamespace[1],
          names: [usingNamespace[1].split('::').pop() ?? usingNamespace[1]],
          line: i + 1,
          external: true,
          kind: 'using',
        });
        continue;
      }
    } else {
      const usingDir = trimmed.match(/^using\s+(?!static\b)([\w.]+)\s*;/);
      if (usingDir) {
        module.imports.push({
          module: usingDir[1],
          names: [usingDir[1].split('.').pop() ?? usingDir[1]],
          line: i + 1,
          external: /^(System|Microsoft|Newtonsoft|NUnit|Xunit|Moq)(\.|$)/.test(usingDir[1]),
          kind: 'using',
        });
        continue;
      }
    }

    const typeMatch = trimmed.match(
      /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new)\s+)*(class|struct|interface|enum|union)\s+([A-Za-z_]\w*)\s*(?:<[^>{]*>)?\s*(?::[^;{]*)?\{/,
    );
    if (typeMatch) {
      const end = blockEnd(code, i, braceColumn(line));
      const typeName = typeMatch[2];
      if (!types.some((entry) => entry.name === typeName && entry.start === i + 1)) {
        const kind =
          typeMatch[1] === 'interface'
            ? 'interface'
            : typeMatch[1] === 'enum'
              ? 'enum'
              : typeMatch[1] === 'class'
                ? 'class'
                : 'struct';
        types.push({ name: typeName, start: i + 1, end: end + 1 });
        const declared = trimmed.match(/^(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new)\s+)*/)?.[0] ?? '';
        module.types.push({
          name: typeName,
          kind,
          startLine: i + 1,
          endLine: end + 1,
          members: kind === 'enum' ? [] : readMembers(code, i + 1, end),
          methods: [],
          exported: dialect === 'csharp' ? /\bpublic\b/.test(declared) : !/\bstatic\b/.test(declared),
        });
      }
      continue;
    }

    const enclosing = [...types].reverse().find((entry) => entry.start < i + 1 && i + 1 <= entry.end);
    if (trimmed.includes('(') && !/;\s*$/.test(trimmed) && !/^(?:namespace|using|template|typedef|friend)\b/.test(trimmed)) {
      const header = readDeclaration(lines, i, 'brace');
      const headerLine = code[header.endLine] ?? '';
      if (!/\{/.test(headerLine)) continue;
      const callable = readCallable(header.text, dialect, enclosing);
      if (!callable) continue;
      const bodyLine = header.endLine;
      const end = blockEnd(code, bodyLine, braceColumn(code[bodyLine]));
      module.functions.push(
        finishFunction(
          {
            name: callable.name,
            params: parseParamList(callable.params, lang, diagnostics),
            returnType: callable.returnType,
            exported:
              dialect === 'csharp'
                ? callable.modifiers.includes('public')
                : !callable.modifiers.includes('static'),
            async: callable.async,
            isMethod: Boolean(callable.className),
            className: callable.className,
            startLine: i + 1,
            endLine: end + 1,
            bodyLines: memberBodyLines(lines, bodyLine + 1, end - 1),
            modifiers: callable.modifiers,
          },
          lang,
          diagnostics,
        ),
      );
      i = end;
      continue;
    }

    if (enclosing) continue;
    const global = trimmed.match(
      /^(?:(?:static|extern|const|constexpr|volatile|unsigned|signed|inline)\s+)*([\w<>[\],.:*&]+(?:\s+[\w<>[\],.:*&]+)*)\s+([A-Za-z_]\w*)\s*(?:=|;)/,
    );
    if (global && !MODIFIERS.has(global[1]) && !TYPE_WORDS.has(global[2]) && !CONTROL.has(global[2])) {
      const type = global[1].trim();
      if (TYPE_WORDS.has(type) || /^[A-Za-z_][\w:<>[\],*& ]*$/.test(type)) {
        module.globals.push({ name: global[2], type, optional: false, line: i + 1 });
      }
    }
  }

  for (const type of module.types) {
    type.methods = module.functions
      .filter((fn) => fn.className === type.name)
      .map((fn) => fn.name);
  }

  if (module.functions.length === 0 && module.types.length === 0) {
    appendDiagnostic(diagnostics, {
      code: 'unparsed-declaration',
      severity: 'info',
      message: `No declaration was recognised by the heuristic ${dialect.toUpperCase()} parser.`,
    });
  }
}
