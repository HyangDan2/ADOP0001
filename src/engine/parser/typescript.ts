import type { Lang, MemberInfo, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import {
  appendDiagnostic,
  KEYWORDS,
  blockEnd,
  braceColumn,
  classifyImport,
  findAssignment,
  findMatching,
  finishFunction,
  isGenericOpen,
  memberBodyLines,
  parseParamList,
  readDeclaration,
  skipSpace,
  splitTopLevel,
} from './normalizer';

/** TypeScript and JavaScript structural parser. */

const TS_MODIFIERS = 'public|private|protected|static|async|readonly|override|abstract|declare|get|set|accessor';

/**
 * Parses the tail of an arrow function: `async (a: T): R =>` or `async a =>`.
 * Used by `const` arrows, `export default` arrows, class fields and object literals.
 */
interface ArrowTail {
  params: string;
  returnType?: string;
  async: boolean;
  /** Generic parameters declared before the parameter list. */
  typeParameters?: string;
  /** Index just after `=>`. */
  arrowAt: number;
}

function parseArrowTail(text: string, from: number): ArrowTail | null {
  let i = skipSpace(text, from);
  let async = false;
  if (text.startsWith('async', i) && !/[\w$]/.test(text[i + 5] ?? '')) {
    async = true;
    i = skipSpace(text, i + 5);
  }
  // `const map = <T, U>(items: T[]) => ...`: a generic arrow declares its type
  // parameters before the parameter list.
  let typeParameters: string | undefined;
  if (text[i] === '<' && isGenericOpen(text, i)) {
    const closeAngle = findMatching(text, i, '<', '>');
    if (closeAngle > 0) {
      typeParameters = text.slice(i + 1, closeAngle).trim() || undefined;
      i = skipSpace(text, closeAngle + 1);
    }
  }
  let params = '';
  if (text[i] === '(') {
    const close = findMatching(text, i, '(', ')');
    if (close < 0) return null;
    params = text.slice(i + 1, close);
    i = skipSpace(text, close + 1);
  } else {
    const single = text.slice(i).match(/^[\w$]+/);
    if (!single) return null;
    params = single[0];
    i = skipSpace(text, i + single[0].length);
  }
  let returnType: string | undefined;
  if (text[i] === ':') {
    const arrow = text.indexOf('=>', i);
    if (arrow < 0) return null;
    returnType = text.slice(i + 1, arrow).trim() || undefined;
    i = skipSpace(text, arrow);
  }
  if (!text.startsWith('=>', i)) return null;
  return { params, returnType, async, typeParameters, arrowAt: i + 2 };
}

/** Reads `name<generics>(params): return` from the start of `text`. */
function readCallable(
  text: string,
  from: number,
  _lang: Lang,
  diagnostics: SourceDiagnostic[],
): { name: string; params: string; returnText?: string; typeParameters?: string; after: number } | null {
  let i = skipSpace(text, from);
  const nameMatch = text.slice(i).match(/^#?[$A-Za-z_][\w$]*/);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i = skipSpace(text, i + name.length);
  let typeParameters: string | undefined;
  if (text[i] === '<') {
    const close = findMatching(text, i, '<', '>');
    if (close > i) {
      typeParameters = text.slice(i + 1, close).trim();
      i = skipSpace(text, close + 1);
    }
  }
  if (text[i] !== '(') return null;
  const close = findMatching(text, i, '(', ')');
  if (close < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `The parameter list of ${name} is not closed; its parameters were read to the end of the line.`,
    });
    return { name, params: text.slice(i + 1).trim(), returnText: undefined, typeParameters, after: text.length };
  }
  const params = text.slice(i + 1, close);
  const rest = text.slice(close + 1);
  let returnText: string | undefined;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    const candidate = rest.slice(colon + 1).replace(/\{\s*$/, '').replace(/\s*=>.*$/, '').trim();
    if (candidate && !candidate.startsWith('=>')) returnText = candidate;
  }
  return { name, params, returnText, typeParameters, after: close + 1 };
}

export function parseJsLike(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const noComment = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const lang = module.language;
  const parsedStarts = new Set<number>();
  let docBuffer: string[] = [];
  let i = 0;

  while (i < noComment.length) {
    const raw = module.lines[i] ?? '';
    const line = noComment[i];
    const codeLine = code[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (!codeLine.trim()) docBuffer = [];
      i += 1;
      continue;
    }
    if (/^\/\*\*?/.test(raw.trim()) || /^\*/.test(raw.trim())) {
      docBuffer.push(raw.trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*/, '').trim());
      i += 1;
      continue;
    }

    // Imports (single line and multi-line, side-effect, `export ... from`).
    if (/^\s*import\b/.test(codeLine) || /^\s*export\b[^;]*\bfrom\b/.test(codeLine)) {
      // The module specifier is a string literal, so it is read from the
      // non-blanked mask; a multi-line import is joined before that.
      const importLines = /from\b|require\(/.test(noComment[i]) ? [noComment[i]] : noComment.slice(i, i + 12);
      const header = readDeclaration(importLines, 0, 'semicolon');
      const sourceMatch = header.text.match(/['"]([^'"]+)['"]/);
      if (sourceMatch) {
        const moduleName = sourceMatch[1];
        const before = header.text
          .slice(0, header.text.indexOf(`'`) >= 0 ? header.text.indexOf(`'`) : header.text.indexOf(`"`))
          .replace(/\bfrom\s*$/, '');
        const requireLike = /^(?:const|let|var)\s+(\w+)\s*=\s*require/.exec(before);
        const names = before
          .replace(/^import\s+(?:type\s+)?/, '')
          .replace(/^export\s+/, '')
          .replace(/[{}*]/g, ' ')
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
          .filter((part) => part.length > 0 && part !== 'default' && part !== 'from');
        module.imports.push({
          module: moduleName,
          names: requireLike ? [requireLike[1]] : names,
          line: i + 1,
          external: classifyImport(moduleName),
          kind: requireLike ? 'require' : 'esm',
        });
      }
      i += Math.max(1, header.endLine + 1);
      docBuffer = [];
      continue;
    }
    const requireMatch = codeLine.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      module.imports.push({
        module: requireMatch[2],
        names: [requireMatch[1]],
        line: i + 1,
        external: classifyImport(requireMatch[2]),
        kind: 'require',
      });
      i += 1;
      continue;
    }

    // Interfaces.
    const ifaceMatch = codeLine.match(/^\s*(export\s+)?(?:declare\s+)?interface\s+([\w$]+)/);
    if (ifaceMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = noComment.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([^{]+)/);
      const typeParams = header.match(/interface\s+[\w$]+\s*<(.+?)>\s*(?:extends|\{)/);
      const members: MemberInfo[] = [];
      let memberLine = openLine + 1;
      while (memberLine < end) {
        const body = noComment[memberLine].trim();
        memberLine += 1;
        if (!body || body.startsWith('//') || body.startsWith('*')) continue;
        const cleaned = body.replace(/;?\s*$/, '');
        if (!cleaned) continue;
        const index = cleaned.match(/^\[(\w+):\s*(.+?)\]:\s*(.+)$/);
        if (index) {
          members.push({ name: `[${index[1]}: ${index[2]}]`, type: index[3].trim(), optional: false, line: memberLine });
          continue;
        }
        const method = readCallable(cleaned, 0, lang, diagnostics);
        if (method && cleaned.includes('(')) {
          members.push({
            name: `${method.name}()`,
            type: method.returnText,
            optional: false,
            line: memberLine,
          });
          continue;
        }
        const prop = cleaned.match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+)$/);
        if (prop) {
          members.push({ name: prop[1], type: prop[3].trim(), optional: Boolean(prop[2]), line: memberLine });
        }
      }
      module.types.push({
        name: ifaceMatch[2],
        kind: 'interface',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1].trim(),
        members,
        methods: members.filter((member) => member.name.endsWith('()')).map((member) => member.name),
        exported: Boolean(ifaceMatch[1]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end + 1;
      docBuffer = [];
      continue;
    }

    // Type aliases and enums.
    const typeMatch = codeLine.match(/^\s*(export\s+)?(?:declare\s+)?type\s+([\w$]+)/);
    if (typeMatch) {
      const header = readDeclaration(noComment, i, 'semicolon');
      const eq = header.text.indexOf('=');
      const aliasBody = eq >= 0 ? header.text.slice(eq + 1).replace(/;\s*$/, '').trim() : undefined;
      const headerWithoutBody = eq >= 0 ? header.text.slice(0, eq) : header.text;
      const typeParams = headerWithoutBody.match(/<(.+)>/);
      const members: MemberInfo[] = [];
      if (aliasBody?.trim().startsWith('{')) {
        for (const part of splitTopLevel(aliasBody.replace(/^\{|\}$/g, ''), ';')) {
          const prop = part.trim().match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+)$/);
          if (prop) members.push({ name: prop[1], type: prop[3].trim(), optional: Boolean(prop[2]), line: i + 1 });
        }
      }
      module.types.push({
        name: typeMatch[2],
        kind: 'type',
        startLine: i + 1,
        endLine: header.endLine + 1,
        members,
        methods: [],
        exported: Boolean(typeMatch[1]),
        aliasBody,
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = header.endLine + 1;
      continue;
    }
    const enumMatch = codeLine.match(/^\s*(export\s+)?(?:const\s+)?enum\s+([\w$]+)/);
    if (enumMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 6) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const members: MemberInfo[] = [];
      for (let j = openLine; j <= end; j += 1) {
        for (const part of splitTopLevel(noComment[j].replace(/^[^{]*\{/, '').replace(/}.*$/, ''), ',')) {
          const name = part.trim().split('=')[0].trim();
          if (name && /^[\w$]+$/.test(name)) members.push({ name, optional: false, line: j + 1 });
        }
      }
      module.types.push({
        name: enumMatch[2],
        kind: 'enum',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: [],
        exported: Boolean(enumMatch[1]),
      });
      parsedStarts.add(i);
      i = end + 1;
      continue;
    }

    // Classes.
    const classMatch = codeLine.match(/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([\w$]+)/);
    if (classMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = noComment.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([\w$.<>]+)/);
      const implementsMatch = header.match(/\bimplements\s+([^{]+)/);
      const typeParams = header.match(/class\s+[\w$]+\s*<(.+?)>\s*(?:extends|implements|\{)/);
      const members: MemberInfo[] = [];
      const methods: string[] = [];
      const className = classMatch[2];

      for (let j = openLine + 1; j < end; j += 1) {
        if (!code[j].trim()) continue;
        const body = noComment[j].trim();
        if (!body || body.startsWith('@')) continue;
        if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(body) || /^interface\b/.test(body)) {
          appendDiagnostic(diagnostics, {
            code: 'nested-type',
            severity: 'info',
            message: `Nested type inside ${className} on line ${j + 1} is only listed as a member name.`,
            line: j + 1,
          });
          const nestedOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{')) k += 1;
            return k;
          })();
          const nestedEnd = blockEnd(code, nestedOpen, braceColumn(code[nestedOpen] ?? ''));
          const nestedName = body.match(/(?:class|interface)\s+([\w$]+)/)?.[1];
          if (nestedName) members.push({ name: nestedName, optional: false, line: j + 1 });
          j = nestedEnd;
          continue;
        }

        // Method / constructor / getter / setter.
        const modifierMatch = body.match(new RegExp(`^((?:(?:${TS_MODIFIERS})\\s+)*)`));
        let rest = body.slice(modifierMatch?.[1].length ?? 0).trim();
        const modifiers = (modifierMatch?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
        rest = rest.replace(/^\*\s*/, '');
        const callable = readCallable(rest, 0, lang, diagnostics);
        if (callable && callable.after > 0 && !KEYWORDS.has(callable.name)) {
          const isCtor = callable.name === className || callable.name === 'constructor';
          methods.push(callable.name);
          members.push({ name: `${callable.name}()`, type: callable.returnText, optional: false, line: j + 1 });
          const methodOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
            return k;
          })();
          const hasBody = code[methodOpen]?.includes('{') ?? false;
          const methodEnd = hasBody ? blockEnd(code, methodOpen, braceColumn(code[methodOpen])) : methodOpen;
          const bodyLines = memberBodyLines(noComment, j + (methodOpen === j ? 1 : 0), methodEnd - 1);
          module.functions.push(
            finishFunction(
              {
                name: callable.name,
                params: parseParamList(callable.params, lang, diagnostics),
                returnType: isCtor ? undefined : callable.returnText,
                exported: Boolean(classMatch[1]) || modifiers.includes('public'),
                async: modifiers.includes('async') || /\basync\b/.test(body),
                isMethod: true,
                className,
                startLine: j + 1,
                endLine: methodEnd + 1,
                bodyLines: bodyLines.filter((item) => item.text.trim() !== '{' && item.text.trim() !== '}'),
                modifiers: isCtor ? ['constructor', ...modifiers] : ['method', ...modifiers],
                typeParameters: callable.typeParameters,
              },
              lang,
              diagnostics,
            ),
          );
          parsedStarts.add(j);
          j = methodEnd;
          continue;
        }

        // Arrow-function field or property function.
        const arrowName = rest.match(/^#?([\w$]+)\s*(?::[^=]+)?=\s*(async\s+)?/);
        const arrowEq = findAssignment(rest);
        const arrowTail = arrowEq >= 0 ? parseArrowTail(rest, arrowEq + 1) : null;
        if (arrowName && arrowTail) {
          const { params, returnType } = arrowTail;
          const arrowOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
            return k;
          })();
          const hasBody = code[arrowOpen]?.includes('{') ?? false;
          const arrowEnd = hasBody ? blockEnd(code, arrowOpen, braceColumn(code[arrowOpen])) : arrowOpen;
          methods.push(arrowName[1]);
          members.push({ name: `${arrowName[1]}()`, type: returnType, optional: false, line: j + 1 });
          module.functions.push(
            finishFunction(
              {
                name: arrowName[1],
                params: parseParamList(params, lang, diagnostics),
                returnType,
                exported: Boolean(classMatch[1]),
                async: Boolean(arrowName[2]) || /\basync\b/.test(body),
                isMethod: true,
                className,
                startLine: j + 1,
                endLine: arrowEnd + 1,
                bodyLines: memberBodyLines(noComment, j + 1, arrowEnd),
                modifiers: ['method', 'field'],
                typeParameters: undefined,
              },
              lang,
              diagnostics,
            ),
          );
          parsedStarts.add(j);
          j = arrowEnd;
          continue;
        }

        // Plain field.
        const field = rest.match(/^#?([\w$]+)(\?)?\s*:\s*(.+?);?$/);
        if (field) {
          members.push({ name: field[1], type: field[3].replace(/;$/, '').trim(), optional: Boolean(field[2]), line: j + 1 });
          continue;
        }
        const assigned = rest.match(/^#?([\w$]+)\s*=/);
        if (assigned) {
          members.push({ name: assigned[1], type: 'inferred', optional: false, line: j + 1 });
        }
      }

      module.types.push({
        name: className,
        kind: 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1],
        implements: implementsMatch?.[1].split(',').map((item) => item.trim()),
        members,
        methods,
        exported: Boolean(classMatch[1]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end + 1;
      docBuffer = [];
      continue;
    }

    // Function declarations (export default / async / generator).
    const fnMatch = codeLine.match(/^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\s*(\*)?\s*([\w$]+)/);
    if (fnMatch) {
      const header = readDeclaration(noComment, i, 'brace');
      const callable = readCallable(header.text, header.text.indexOf('function') + 'function'.length, lang, diagnostics);
      if (callable) {
        const hasBody = header.text.includes('{');
        const openLine = header.endLine;
        const end = hasBody ? blockEnd(code, openLine, braceColumn(code[openLine])) : openLine;
        module.functions.push(
          finishFunction(
            {
              name: callable.name === 'function' ? fnMatch[6] : callable.name,
              params: parseParamList(callable.params, lang, diagnostics),
              returnType: callable.returnText,
              exported: Boolean(fnMatch[1]) || Boolean(fnMatch[2]),
              async: Boolean(fnMatch[4]),
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: hasBody ? memberBodyLines(noComment, i + 1, end - 1) : [],
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: [fnMatch[5] ? 'generator' : '', fnMatch[3] ? 'declare' : ''].filter(Boolean),
              typeParameters: callable.typeParameters,
            },
            lang,
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }
    }

    // `const name = (args) => ...`, `const name = async x => ...`, function expressions,
    // and `export default (args) => ...`.
    const declMatch = codeLine.match(/^\s*(export\s+)?(default\s+)?(?:const|let|var)\s+([\w$]+)/)
      ?? codeLine.match(/^\s*(export\s+)?(default\s+)\s*(?=\()/);
    if (declMatch) {
      const header = readDeclaration(noComment, i, 'arrow');
      const name = declMatch[3] ?? 'default';
      const eq = findAssignment(header.text);
      // `export default (args) => ...` has no `=`; the arrow starts after `default`.
      const declAt = declMatch[3] ? eq + 1 : header.text.indexOf('default') + 'default'.length;
      const arrowTail = declAt > 0 ? parseArrowTail(header.text, declAt) : null;
      if (arrowTail) {
        const { params, returnType } = arrowTail;
        const isBlock = header.text.slice(arrowTail.arrowAt).includes('{');
        const openLine = header.endLine;
        const end = isBlock ? blockEnd(code, openLine, braceColumn(code[openLine])) : openLine;
        module.functions.push(
          finishFunction(
            {
              name,
              params: parseParamList(params, lang, diagnostics),
              returnType,
              exported: Boolean(declMatch[1]) || Boolean(declMatch[2]),
              async: arrowTail.async,
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: isBlock ? memberBodyLines(noComment, i + 1, end - 1) : memberBodyLines(noComment, i, i),
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: [],
              typeParameters: arrowTail.typeParameters,
            },
            lang,
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }

      // Object literal with methods: `const api = { charge(...) {} }`.
      const braceAt = header.text.indexOf('{');
      if (braceAt >= 0 && /=\s*\{/.test(header.text)) {
        const objectName = name;
        const openLine = header.endLine;
        const end = blockEnd(code, openLine, braceColumn(code[openLine]));
        for (let j = openLine + 1; j < end; j += 1) {
          const body = noComment[j].trim();
          if (!body) continue;
          const methodMatch = body.match(/^(async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*(?:<[^>]*>)?\s*\(/);
          if (methodMatch) {
            const open = (() => {
              let k = j;
              while (k < end && !code[k].includes('{')) k += 1;
              return k;
            })();
            const methodEnd = blockEnd(code, open, braceColumn(code[open]));
            const callable = readCallable(body, body.indexOf(methodMatch[2]), lang, diagnostics);
            module.functions.push(
              finishFunction(
                {
                  name: methodMatch[2],
                  params: callable ? parseParamList(callable.params, lang, diagnostics) : [],
                  returnType: callable?.returnText,
                  exported: Boolean(declMatch[1]),
                  async: Boolean(methodMatch[1]),
                  isMethod: true,
                  className: objectName,
                  startLine: j + 1,
                  endLine: methodEnd + 1,
                  bodyLines: memberBodyLines(noComment, j + 1, methodEnd - 1),
                  modifiers: ['method', 'object-literal'],
                },
                lang,
                diagnostics,
              ),
            );
            parsedStarts.add(j);
            j = methodEnd;
            continue;
          }
          const arrowProp = body.match(/^(async\s+)?([\w$]+)\s*:\s*(async\s+)?\(/);
          if (arrowProp) {
            const arrow = parseArrowTail(body, body.indexOf(':', body.indexOf(arrowProp[2])) + 1);
            module.functions.push(
              finishFunction(
                {
                  name: arrowProp[2],
                  params: arrow ? parseParamList(arrow.params, lang, diagnostics) : [],
                  returnType: arrow?.returnType,
                  exported: Boolean(declMatch[1]),
                  async: Boolean(arrowProp[1] ?? arrowProp[3]),
                  isMethod: true,
                  className: objectName,
                  startLine: j + 1,
                  endLine: j + 1,
                  bodyLines: [],
                  modifiers: ['method', 'object-literal', 'field'],
                },
                lang,
                diagnostics,
              ),
            );
          }
        }
        module.globals.push({ name: objectName, type: 'object', optional: false, line: i + 1 });
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }

      // A global constant / variable.
      if (eq >= 0) {
        const type = header.text.slice(0, eq).split(':').slice(1).join(':').trim() || 'inferred';
        module.globals.push({ name, type, optional: false, line: i + 1 });
      }
      i = header.endLine + 1;
      docBuffer = [];
      continue;
    }

    docBuffer = [];
    i += 1;
  }

  // Anything that looks like a declaration but was not read is reported, never silently dropped.
  for (let index = 0; index < code.length; index += 1) {
    const line = code[index];
    if (!line.trim() || parsedStarts.has(index)) continue;
    if (/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|type)\s+[\w$]+\s*[({<]/.test(line)) {
      appendDiagnostic(diagnostics, {
        code: 'unparsed-declaration',
        severity: 'warn',
        message: `Line ${index + 1} looks like a declaration but could not be read as one.`,
        line: index + 1,
      });
    }
  }
}


/* ------------------------------------------------------------------ */
/* Python                                                            */
/* ------------------------------------------------------------------ */
