import type { MemberInfo, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import {
  blockEnd,
  braceColumn,
  classifyImport,
  findMatching,
  finishFunction,
  memberBodyLines,
  parseParamList,
  readDeclaration,
} from './normalizer';

/** Go structural parser. */

export function parseGo(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+\(/.test(code[i])) {
      let j = i + 1;
      for (; j < lines.length && !/^\s*\)/.test(code[j]); j += 1) {
        const match = lines[j].match(/(?:([\w.]+)\s+)?"([^"]+)"/);
        if (match) {
          module.imports.push({
            module: match[2],
            names: [match[1] ?? match[2].split('/').pop() ?? ''],
            line: j + 1,
            external: classifyImport(match[2]),
            kind: 'go',
          });
        }
      }
      i = j;
      continue;
    }
    // The import path lives in a string literal, which `code` blanks.
    const singleImport = lines[i].match(/^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/);
    if (singleImport) {
      module.imports.push({
        module: singleImport[2],
        names: [singleImport[1] ?? singleImport[2].split('/').pop() ?? ''],
        line: i + 1,
        external: classifyImport(singleImport[2]),
        kind: 'go',
      });
      continue;
    }

    const structMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s+struct\s*\{/);
    if (structMatch) {
      const end = blockEnd(code, i, braceColumn(code[i]));
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j].trim();
        if (!line) continue;
        const embedded = line.match(/^(\*?[\w.]+(?:\[[^\]]*\])?)$/);
        if (embedded) {
          members.push({ name: embedded[1], type: embedded[1], optional: false, line: j + 1 });
          continue;
        }
        const field = line.match(/^(\w+)\s+([\w.[\]*{}]+)/);
        if (field) members.push({ name: field[1], type: field[2], optional: false, line: j + 1 });
      }
      module.types.push({
        name: structMatch[1],
        kind: 'struct',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: [],
        exported: /^[A-Z]/.test(structMatch[1]),
        typeParameters: structMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      i = end;
      continue;
    }
    const ifaceMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s+interface\s*\{/);
    if (ifaceMatch) {
      const end = blockEnd(code, i, braceColumn(code[i]));
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j].trim();
        if (!line) continue;
        const method = line.match(/^(\w+)\s*\(/);
        if (method) members.push({ name: `${method[1]}()`, optional: false, line: j + 1 });
      }
      module.types.push({
        name: ifaceMatch[1],
        kind: 'interface',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: members.map((member) => member.name),
        exported: /^[A-Z]/.test(ifaceMatch[1]),
        typeParameters: ifaceMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      i = end;
      continue;
    }
    const aliasMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/);
    if (aliasMatch) {
      module.types.push({
        name: aliasMatch[1],
        kind: 'type',
        startLine: i + 1,
        endLine: i + 1,
        members: [],
        methods: [],
        exported: /^[A-Z]/.test(aliasMatch[1]),
        aliasBody: aliasMatch[3].trim(),
        typeParameters: aliasMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      continue;
    }

    const funcMatch = code[i].match(/^\s*func\s+(?:\(\s*(\w+)\s+(\*?[\w.]+(?:\[[^\]]*\])?)\s*\)\s*)?(\w+)\s*(?:\[([^\]]*)\])?\s*\(/);
    if (funcMatch) {
      const header = readDeclaration(lines, i, 'brace');
      const nameAt = header.text.indexOf(funcMatch[3]);
      const openInHeader = header.text.indexOf('(', nameAt + funcMatch[3].length);
      const close = openInHeader >= 0 ? findMatching(header.text, openInHeader, '(', ')') : -1;
      const params = close > 0 ? header.text.slice(openInHeader + 1, close) : '';
      const afterParams = close > 0 ? header.text.slice(close + 1).replace(/\{\s*$/, '').trim() : '';
      const bodyOpen = (() => {
        let k = i;
        while (k < code.length && !code[k].includes('{')) k += 1;
        return k;
      })();
      const end = blockEnd(code, bodyOpen, braceColumn(code[bodyOpen] ?? ''));
      module.functions.push(
        finishFunction(
          {
            name: funcMatch[3],
            params: parseParamList(params, 'go', diagnostics),
            returnType: afterParams || undefined,
            exported: /^[A-Z]/.test(funcMatch[3]),
            async: false,
            isMethod: Boolean(funcMatch[2]),
            className: funcMatch[2]?.replace(/^\*/, '').replace(/\[.*$/, ''),
            startLine: i + 1,
            endLine: end + 1,
            bodyLines: memberBodyLines(lines, bodyOpen + 1, end - 1),
            modifiers: funcMatch[1] ? ['method', `receiver ${funcMatch[1]}`] : [],
            typeParameters: funcMatch[4]?.trim(),
          },
          'go',
          diagnostics,
        ),
      );
      parsedStarts.add(i);
      i = Math.max(end, header.endLine);
      continue;
    }

    const globalMatch = code[i].match(/^\s*(?:var|const)\s+(\w+)\s+([\w.[\]*]+)?/);
    if (globalMatch) {
      module.globals.push({
        name: globalMatch[1],
        type: globalMatch[2] ?? 'inferred',
        optional: false,
        line: i + 1,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                       */
/* ------------------------------------------------------------------ */
