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
import {
  LANGUAGE_PARSERS,
  extensionOf,
  languageFromExtension,
  languageLabel,
  parserFor,
} from './registry';
import { appendDiagnostic } from './normalizer';

export * from './types';
export { LANGUAGE_PARSERS, extensionOf, languageLabel, parserFor } from './registry';

export function detectLanguage(fileName: string, source: string): Lang {
  const extension = extensionOf(fileName);
  // A bare .h header can hold either dialect; the content decides.
  if (extension !== 'h') {
    const fromExtension = languageFromExtension(fileName);
    if (fromExtension) return fromExtension;
  }
  for (const parser of LANGUAGE_PARSERS) {
    if (parser.language === 'cpp' && extension === 'h') {
      if (parser.detect?.(source)) return 'cpp';
      continue;
    }
    if (parser.detect?.(source)) return parser.language;
  }
  if (extension === 'h') return 'c';
  return 'unknown';
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
    const parser = parserFor(language);
    if (parser) parser.parse(module, mask, diagnostics);
    else parseJsLike(module, mask, diagnostics);
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
