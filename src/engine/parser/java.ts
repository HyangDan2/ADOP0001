import type { MemberInfo, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import {
  appendDiagnostic,
  blockEnd,
  braceColumn,
  classifyImport,
  findMatching,
  finishFunction,
  memberBodyLines,
  parseParamList,
  readDeclaration,
} from './normalizer';

/** Java structural parser. */

export function parseJava(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const importMatch = code[i].match(/^\s*import\s+(?:static\s+)?([\w.*]+);?/);
    if (importMatch) {
      module.imports.push({
        module: importMatch[1],
        names: [importMatch[1].split('.').pop() ?? ''],
        line: i + 1,
        external: classifyImport(importMatch[1]),
        kind: 'java',
      });
      continue;
    }

    const classMatch = code[i].match(/^\s*(?:public\s+|final\s+|abstract\s+|sealed\s+|strictfp\s+)*(class|interface|enum|record)\s+(\w+)/);
    if (classMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = lines.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([\w<>.,\s]+)/);
      const implementsMatch = header.match(/\bimplements\s+([\w<>.,\s]+)/);
      const typeParams = header.match(new RegExp(`${classMatch[1]}\\s+\w+\\s*<(.+?)>\\s*(?:extends|implements|\\{)`));
      const className = classMatch[2];
      const members: MemberInfo[] = [];
      const methods: string[] = [];

      for (let j = openLine + 1; j < end; j += 1) {
        const body = lines[j].trim();
        const codeBody = code[j].trim();
        if (!codeBody || body.startsWith('@')) continue;
        if (/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+|strictfp\s+)*(class|interface|enum|record)\s+\w+/.test(codeBody)) {
          appendDiagnostic(diagnostics, {
            code: 'nested-type',
            severity: 'info',
            message: `Nested type inside ${className} on line ${j + 1} is listed by name only.`,
            line: j + 1,
          });
          const nestedOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{')) k += 1;
            return k;
          })();
          const nestedEnd = blockEnd(code, nestedOpen, braceColumn(code[nestedOpen] ?? ''));
          const nestedName = codeBody.match(/(?:class|interface|enum|record)\s+(\w+)/)?.[1];
          if (nestedName) members.push({ name: nestedName, optional: false, line: j + 1 });
          j = nestedEnd;
          continue;
        }

        const hasParen = codeBody.includes('(');
        if (!hasParen) {
          const field = codeBody
            .replace(/^(?:(?:public|private|protected|static|final|transient|volatile)\s+)+/, '')
            .match(/^([\w.$<>[\], ?]+)\s+(\w+)\s*(?:=|;)/);
          if (field) members.push({ name: field[2], type: field[1], optional: false, line: j + 1 });
          continue;
        }

        const declaration = readDeclaration(lines, j, codeBody.endsWith(';') ? 'semicolon' : 'brace');
        const text = declaration.text.replace(/;\s*$/, '').replace(/\{\s*$/, '').trim();
        let rest = text;
        const modifiers: string[] = [];
        let modifierLoop = true;
        while (modifierLoop) {
          const next = rest.replace(/^(public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+/, '');
          if (next === rest) modifierLoop = false;
          else {
            modifiers.push(rest.slice(0, rest.length - next.length).trim());
            rest = next;
          }
        }
        let typeParameters: string | undefined;
        if (rest.startsWith('<')) {
          const closeAngle = findMatching(rest, 0, '<', '>');
          if (closeAngle > 0) {
            typeParameters = rest.slice(1, closeAngle).trim();
            rest = rest.slice(closeAngle + 1).trim();
          }
        }
        const open = rest.indexOf('(');
        if (open < 0) continue;
        const before = rest.slice(0, open).trim();
        const nameMatch = before.match(/([\w$]+)$/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        if (/^(if|for|while|switch|catch|new|return)$/.test(name)) continue;
        const returnRaw = before.slice(0, before.length - name.length).trim();
        const isCtor = name === className && returnRaw.length === 0;
        const close = findMatching(rest, open, '(', ')');
        const params = close > 0 ? rest.slice(open + 1, close) : rest.slice(open + 1);
        const after = close > 0 ? rest.slice(close + 1) : '';
        const throwsMatch = after.match(/throws\s+([\w.,\s]+)/);
        const bodyOpen = (() => {
          let k = j;
          while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
          return k;
        })();
        const hasBody = (code[bodyOpen] ?? '').includes('{');
        const methodEnd = hasBody ? blockEnd(code, bodyOpen, braceColumn(code[bodyOpen] ?? '')) : bodyOpen;
        methods.push(name);
        members.push({ name: `${name}()`, type: isCtor ? undefined : returnRaw, optional: false, line: j + 1 });
        module.functions.push(
          finishFunction(
            {
              name,
              params: parseParamList(params, 'java', diagnostics),
              returnType: isCtor || returnRaw === 'void' ? undefined : returnRaw || undefined,
              exported: modifiers.includes('public'),
              async: false,
              isMethod: true,
              className,
              startLine: j + 1,
              endLine: methodEnd + 1,
              bodyLines: hasBody ? memberBodyLines(lines, j + 1, methodEnd - 1) : [],
              modifiers: isCtor
                ? ['constructor', ...modifiers]
                : ['method', ...modifiers, ...(throwsMatch ? [`throws ${throwsMatch[1].trim()}`] : [])],
              typeParameters,
            },
            'java',
            diagnostics,
          ),
        );
        parsedStarts.add(j);
        j = Math.max(j, declaration.endLine);
        if (hasBody) j = methodEnd;
      }

      module.types.push({
        name: className,
        kind: classMatch[1] === 'interface' ? 'interface' : classMatch[1] === 'enum' ? 'enum' : 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1].trim(),
        implements: implementsMatch?.[1].split(',').map((item) => item.trim()),
        members,
        methods,
        exported: /public/.test(code[i]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Go                                                                */
/* ------------------------------------------------------------------ */
