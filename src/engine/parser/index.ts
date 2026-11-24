/**
 * Parser entry point: language detection, masking and dispatch.
 *
 * The parser is heuristic by design (no compiler AST); every construct it
 * cannot read completely is reported through `SourceDiagnostic` instead of
 * being dropped silently.
 */

import type { FunctionInfo, Lang, Param, ParsedModule, SourceDiagnostic } from './types';
import { maskSource } from './tokenizer';
import { parseJsLike } from './typescript';
import { parsePython } from './python';
import { parseJava } from './java';
import { parseGo } from './go';
import { appendDiagnostic } from './normalizer';

export * from './types';

export function detectLanguage(fileName: string, source: string): Lang {
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'go':
      return 'go';
    default:
      break;
  }
  if (/^\s*package\s+\w+/m.test(source) && /func\s+\w+\s*\(/.test(source)) return 'go';
  if (/(^|\n)\s*(public|private|protected)\s+\w+[\w<>[\], ]*\s+\w+\s*\(/m.test(source)) return 'java';
  if (/(^|\n)\s*(?:async\s+)?def\s+\w+\s*\(/m.test(source)) return 'python';
  if (/interface\s+\w+|:\s*(string|number|boolean)\b/.test(source)) return 'typescript';
  if (/(^|\n)\s*(const|let|var|function)\s/.test(source)) return 'javascript';
  return 'unknown';
}

export function languageLabel(lang: Lang): string {
  switch (lang) {
    case 'typescript': return 'TypeScript';
    case 'javascript': return 'JavaScript';
    case 'python': return 'Python';
    case 'java': return 'Java';
    case 'go': return 'Go';
    default: return 'Unknown';
  }
}

export function parseSource(fileName: string, source: string): ParsedModule {
  const language = detectLanguage(fileName, source);
  const maskLang: Lang = language === 'unknown' ? 'javascript' : language;
  const mask = maskSource(source, maskLang);
  const diagnostics: SourceDiagnostic[] = [...mask.diagnostics];

  const module: ParsedModule = {
    fileName,
    language,
    lines: source.replace(/\r\n?/g, '\n').split('\n'),
    imports: [],
    functions: [],
    types: [],
    globals: [],
    callGraph: [],
    notes: [],
    diagnostics,
  };

  if (language === 'unknown') {
    appendDiagnostic(diagnostics, {
      code: 'unknown-language',
      severity: 'info',
      message: 'Language not recognised; only structural hints were extracted with the JavaScript rules.',
    });
  }

  let braceBalance = 0;
  for (const line of mask.code.split('\n')) {
    for (const ch of line) {
      if (ch === '{') braceBalance += 1;
      else if (ch === '}') braceBalance -= 1;
    }
  }
  if (language !== 'python' && braceBalance !== 0) {
    appendDiagnostic(diagnostics, {
      code: 'unbalanced-braces',
      severity: 'warn',
      message: `Braces do not balance (${braceBalance > 0 ? 'missing }' : 'extra }'}); some blocks were read to the end of the file.`,
    });
  }

  try {
    if (language === 'typescript' || language === 'javascript' || language === 'unknown') parseJsLike(module, mask, diagnostics);
    else if (language === 'python') parsePython(module, mask, diagnostics);
    else if (language === 'java') parseJava(module, mask, diagnostics);
    else if (language === 'go') parseGo(module, mask, diagnostics);
  } catch (cause) {
    appendDiagnostic(diagnostics, {
      code: 'parser-error',
      severity: 'warn',
      message: `The ${languageLabel(language)} parser stopped early: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const ownNames = new Set<string>([
    ...module.functions.map((fn) => fn.name),
    ...module.types.map((type) => type.name),
  ]);
  const calls = new Set<string>();
  for (const fn of module.functions) {
    for (const call of fn.calls) {
      const tail = call.split('.').pop() ?? call;
      if (!ownNames.has(call) && !ownNames.has(tail) && module.imports.some((imp) => imp.names.includes(call.split('.')[0]))) {
        calls.add(call);
      }
    }
  }
  module.callGraph = [...calls];

  if (module.functions.length === 0 && module.types.length === 0) {
    appendDiagnostic(diagnostics, {
      code: 'unparsed-declaration',
      severity: 'info',
      message: 'No function or type declarations were found in this source.',
    });
  }

  module.notes = [...new Set(diagnostics.map((diagnostic) => diagnostic.message))];
  return module;
}

export function paramLabel(param: Param): string {
  const type = param.type ? `: ${param.type}` : '';
  const def = param.defaultValue !== undefined ? ` = ${param.defaultValue}` : '';
  const opt = param.optional && param.defaultValue === undefined ? '?' : '';
  return `${param.name}${opt}${type}${def}`;
}

export function signatureOf(fn: FunctionInfo): string {
  const prefix = fn.isMethod && fn.className ? `${fn.className}.` : '';
  const generics = fn.typeParameters ? `<${fn.typeParameters}>` : '';
  const params = fn.params.map(paramLabel).join(', ');
  const ret = fn.returnType ? ` -> ${fn.returnType}` : '';
  return `${prefix}${fn.name}${generics}(${params})${ret}`;
}
