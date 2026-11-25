import type { MemberInfo, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import {
  classifyImport,
  findMatching,
  finishFunction,
  memberBodyLines,
  parseParamList,
  readDeclaration,
  type Header,
} from './normalizer';

/** Python structural parser. */

function pythonBlockEnd(lines: string[], startIndex: number): number {
  const baseIndent = (lines[startIndex].match(/^[ \t]*/)?.[0].length ?? 0) as number;
  let last = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    last = i;
  }
  return last;
}

/** Python decorators immediately above a `def`/`class`, including multi-line ones. */
function pythonDecorators(lines: string[], defIndex: number): string[] {
  const found: string[] = [];
  for (let i = defIndex - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('@')) break;
    let name = line.slice(1).trim();
    let paren = 0;
    for (const ch of name) {
      if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
    }
    // A decorator whose call spans lines: walk upwards until the parens close.
    let j = i;
    while (paren > 0 && j > 0) {
      j -= 1;
      name = `${lines[j].trim()} ${name}`;
      for (const ch of lines[j]) {
        if (ch === '(') paren += 1;
        else if (ch === ')') paren -= 1;
      }
    }
    found.unshift(name.trim());
    i = j;
  }
  return found;
}

function pythonModifiers(decorators: string[]): string[] {
  const modifiers = ['method'];
  for (const decorator of decorators) {
    const name = decorator.replace(/^@/, '').split('(')[0].trim();
    if (name === 'staticmethod') modifiers.push('static');
    else if (name === 'classmethod') modifiers.push('classmethod');
    else if (name === 'property') modifiers.push('property');
    else if (name === 'abstractmethod') modifiers.push('abstract');
    else if (name.endsWith('.setter')) modifiers.push('setter');
    modifiers.push(`decorator:${name}`);
  }
  return modifiers;
}

function pyHeader(lines: string[], start: number): Header {
  return readDeclaration(lines, start, 'colon');
}

function readPyDef(
  header: Header,
  diagnostics: SourceDiagnostic[],
): { name: string; params: string; returnText?: string; async: boolean } | null {
  const match = header.text.match(/^\s*(async\s+)?def\s+(\w+)/);
  if (!match) return null;
  let open = -1;
  for (let i = match[0].length; i < header.text.length; i += 1) {
    if (header.text[i] === '(') {
      open = i;
      break;
    }
  }
  if (open < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `Python function ${match[2]} has no parameter list.`,
    });
    return { name: match[2], params: '', async: Boolean(match[1]) };
  }
  const close = findMatching(header.text, open, '(', ')');
  if (close < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `Python function ${match[2]} has an unclosed parameter list.`,
    });
    return { name: match[2], params: header.text.slice(open + 1), async: Boolean(match[1]) };
  }
  const params = header.text.slice(open + 1, close);
  const after = header.text.slice(close + 1);
  const arrow = after.match(/->\s*([^:]+):\s*$/);
  return {
    name: match[2],
    params,
    returnText: arrow?.[1].trim(),
    async: Boolean(match[1]),
  };
}

export function parsePython(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();
  let docBuffer: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = module.lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) {
      docBuffer = [];
      continue;
    }
    if (/^#/.test(trimmed)) {
      docBuffer.push(trimmed.replace(/^#+\s?/, ''));
      continue;
    }
    if (/^("""|''')/.test(trimmed)) {
      docBuffer.push(trimmed.replace(/^("""|''')/, '').replace(/("""|''')$/, ''));
      continue;
    }

    const importMatch = code[i].match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        module.imports.push({ module: name, names: [], line: i + 1, external: classifyImport(name), kind: 'python' });
      }
      continue;
    }
    const fromMatch = code[i].match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      module.imports.push({
        module: fromMatch[1],
        names: fromMatch[2].replace(/[()]/g, '').split(',').map((item) => item.trim()).filter(Boolean),
        line: i + 1,
        external: classifyImport(fromMatch[1]),
        kind: 'python',
      });
      continue;
    }

    const classMatch = code[i].match(/^(\s*)class\s+(\w+)/);
    if (classMatch) {
      const header = readDeclaration(lines, i, 'colon');
      const end = pythonBlockEnd(code, i);
      const baseIndent = classMatch[1].length;
      const inheritance = header.text.match(/class\s+\w+\s*(?:\(([^)]*)\))?/);
      const typeParams = inheritance?.[1]?.match(/\[(.+)\]/)?.[1];
      const members: MemberInfo[] = [];
      const methods: string[] = [];

      for (let j = i + 1; j <= end; j += 1) {
        const defMatch = code[j].match(/^(\s*)(async\s+)?def\s+(\w+)/);
        if (defMatch && defMatch[1].length > baseIndent) {
          const defHeader = pyHeader(lines, j);
          const def = readPyDef(defHeader, diagnostics);
          if (def) {
            const decorators = pythonDecorators(lines, j);
            methods.push(def.name);
            members.push({ name: `${def.name}()`, type: def.returnText, optional: false, line: j + 1 });
            const methodEnd = pythonBlockEnd(code, Math.max(j, defHeader.endLine));
            module.functions.push(
              finishFunction(
                {
                  name: def.name,
                  params: parseParamList(def.params, 'python', diagnostics).filter(
                    (param) => param.name !== 'self' && param.name !== 'cls',
                  ),
                  returnType: def.returnText,
                  exported: false,
                  async: def.async,
                  isMethod: true,
                  className: classMatch[2],
                  startLine: j + 1,
                  endLine: methodEnd + 1,
                  bodyLines: memberBodyLines(lines, j + 1, methodEnd),
                  modifiers: pythonModifiers(decorators),
                },
                'python',
                diagnostics,
              ),
            );
            parsedStarts.add(j);
            j = Math.max(j, defHeader.endLine);
          }
          continue;
        }
        const attr = code[j].match(/^(\s+)self\.(\w+)\s*(?::\s*([^=]+))?=/);
        if (attr && attr[1].length > baseIndent) {
          members.push({ name: attr[2], type: attr[3]?.trim(), optional: false, line: j + 1 });
          continue;
        }
        const annotated = code[j].match(/^(\s+)([A-Za-z_]\w*)\s*:\s*(.+?)\s*(?:=.*)?$/);
        if (annotated && annotated[1].length > baseIndent && !/^\s*(def|class|return|if|for|while|with)\b/.test(code[j])) {
          members.push({ name: annotated[2], type: annotated[3].trim(), optional: false, line: j + 1 });
        }
      }

      module.types.push({
        name: classMatch[2],
        kind: 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: inheritance?.[1]?.trim(),
        members,
        methods,
        exported: !classMatch[2].startsWith('_'),
        typeParameters: typeParams,
      });
      parsedStarts.add(i);
      i = end;
      docBuffer = [];
      continue;
    }

    const defMatch = code[i].match(/^(\s*)(async\s+)?def\s+(\w+)/);
    if (defMatch) {
      const header = pyHeader(lines, i);
      const def = readPyDef(header, diagnostics);
      if (def) {
        const end = pythonBlockEnd(code, Math.max(i, header.endLine));
        const decorators = pythonDecorators(lines, i);
        module.functions.push(
          finishFunction(
            {
              name: def.name,
              params: parseParamList(def.params, 'python', diagnostics),
              returnType: def.returnText,
              exported: !def.name.startsWith('_'),
              async: def.async,
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: memberBodyLines(lines, i + 1, end),
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: decorators.map((decorator) => `decorator:${decorator.replace(/^@/, '')}`),
            },
            'python',
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end;
        docBuffer = [];
        continue;
      }
    }

    const globalMatch = code[i].match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+))?=\s*(.+)$/);
    if (globalMatch) {
      module.globals.push({
        name: globalMatch[1],
        type: globalMatch[2]?.trim() ?? 'inferred',
        optional: false,
        line: i + 1,
      });
    }
    if (!/^\s/.test(raw)) docBuffer = [];
  }
}

/* ------------------------------------------------------------------ */
/* Java                                                              */
/* ------------------------------------------------------------------ */
