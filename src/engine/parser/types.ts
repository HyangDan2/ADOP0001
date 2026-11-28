/**
 * Public language-neutral model shared by every parser and engine consumer.
 * Shape-compatible with the original `src/lib/source.ts` exports.
 */

export type Lang =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'unknown';

export interface Param {
  name: string;
  type?: string;
  defaultValue?: string;
  optional: boolean;
  variadic?: boolean;
}

export interface Guard {
  line: number;
  condition: string;
  /** What the guard does when it trips. */
  action: 'return' | 'throw' | 'continue' | 'break';
  detail?: string;
}

export interface ErrorPath {
  line: number;
  error: string;
  message?: string;
}

export interface Statement {
  /** 1-based line in the original source. */
  line: number;
  /** Normalised text of the statement. */
  text: string;
  kind: 'if' | 'else' | 'for' | 'while' | 'try' | 'catch' | 'return' | 'call' | 'assign' | 'throw' | 'other';
  /** For control flow keywords that open a block. */
  branch?: 'if' | 'else' | 'for' | 'while' | 'try' | 'catch';
}

export interface FunctionInfo {
  name: string;
  params: Param[];
  returnType?: string;
  exported: boolean;
  async: boolean;
  isMethod: boolean;
  className?: string;
  startLine: number;
  endLine: number;
  body: Statement[];
  guards: Guard[];
  errors: ErrorPath[];
  calls: string[];
  doc?: string;
  modifiers: string[];
  /** Generic parameters exactly as declared, e.g. `T, U extends Item`. */
  typeParameters?: string;
}

export interface MemberInfo {
  name: string;
  type?: string;
  optional: boolean;
  line: number;
}

export interface TypeInfo {
  name: string;
  kind: 'interface' | 'class' | 'struct' | 'enum' | 'type';
  /** Body of a type alias, kept for the specification's data-type section. */
  aliasBody?: string;
  startLine: number;
  endLine: number;
  extends?: string;
  implements?: string[];
  members: MemberInfo[];
  methods: string[];
  exported: boolean;
  typeParameters?: string;
}

export interface ImportInfo {
  module: string;
  names: string[];
  line: number;
  external: boolean;
  kind: 'esm' | 'require' | 'python' | 'java' | 'go' | 'include' | 'using';
}

/**
 * A construct the heuristics could only support partially. Diagnostics are
 * informational for the UI and are mirrored into `notes` in English so the
 * generated specification can report them.
 */
export interface SourceDiagnostic {
  code:
    | 'unknown-language'
    | 'unterminated-string'
    | 'unterminated-comment'
    | 'unbalanced-braces'
    | 'unparsed-declaration'
    | 'unsupported-parameter'
    | 'nested-type'
    | 'parser-error';
  severity: 'info' | 'warn';
  message: string;
  line?: number;
}

export interface ParsedModule {
  fileName: string;
  language: Lang;
  lines: string[];
  imports: ImportInfo[];
  functions: FunctionInfo[];
  types: TypeInfo[];
  /** Top-level constants and mutable bindings. */
  globals: MemberInfo[];
  /** All call targets seen, unique, excluding the module's own definitions. */
  callGraph: string[];
  notes: string[];
  diagnostics: SourceDiagnostic[];
}
