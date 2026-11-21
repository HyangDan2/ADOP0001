/**
 * Kozue (梢絵) — code to UML auto-architect.
 * Scores five UML kinds from the static model, explains the choice, and emits a
 * Mermaid definition for whichever kind the user selects.
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import { parseSource, type FunctionInfo, type ParsedModule } from '../../lib/source';

export type UmlKind = 'sequence' | 'class' | 'state' | 'activity' | 'component';
export type Direction = 'TD' | 'LR';

export interface UmlCandidate {
  kind: UmlKind;
  score: number;
  reasons: string[];
}

export interface UmlDetection {
  selected: UmlKind;
  confidence: number;
  candidates: UmlCandidate[];
}

export interface KozueOptions {
  kind?: UmlKind | 'auto';
  direction: Direction;
}

export interface KozueOutput {
  detection: UmlDetection;
  /** The kind actually rendered (auto resolves to the detection's choice). */
  activeKind: UmlKind;
  mermaid: Record<UmlKind, string>;
  autoSelection: UmlKind;
}

const KIND_LABEL: Record<UmlKind, string> = {
  sequence: 'Sequence Diagram',
  class: 'Class Diagram',
  state: 'State Diagram',
  activity: 'Activity Diagram',
  component: 'Component Diagram',
};

export function kindLabel(kind: UmlKind): string {
  return KIND_LABEL[kind];
}

function sanitizeLabel(text: string, max = 64): string {
  const clean = text
    .replace(/"/g, "'")
    .replace(/[\n\r]+/g, ' ')
    .replace(/[{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function mermaidId(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : `n_${id}`;
}

const STATUS_TOKENS = /['"](draft|pending|active|inactive|paid|unpaid|open|closed|approved|rejected|failed|done|idle|running|queued|cancelled|canceled|completed|error|success)['"]/i;

function detectKind(mod: ParsedModule): UmlDetection {
  const candidates: UmlCandidate[] = [];
  const totalCalls = mod.functions.reduce((sum, fn) => sum + fn.calls.length, 0);
  const allStatements = mod.functions.flatMap((fn) => fn.body);
  const controls = allStatements.filter((s) => ['if', 'for', 'while', 'try', 'catch'].includes(s.kind));
  const guards = mod.functions.flatMap((fn) => fn.guards);
  const statusHits = mod.lines.filter((line) => STATUS_TOKENS.test(line)).length;
  const external = mod.imports.filter((i) => i.external);
  const relationTypes = mod.types.filter((t) => t.kind !== 'type' && (t.extends || (t.implements && t.implements.length))).length;

  const classReasons: string[] = [];
  let classScore = 0;
  if (mod.types.length >= 2) { classScore += 7; classReasons.push(`${mod.types.length} declared types with members`); }
  else if (mod.types.length === 1) { classScore += 2; classReasons.push('one declared type'); }
  if (relationTypes > 0) { classScore += 3; classReasons.push('inheritance or implementation relationships'); }
  if (mod.types.reduce((n, t) => n + t.methods.length, 0) >= 3) { classScore += 2; classReasons.push('type methods form a shared contract'); }
  candidates.push({ kind: 'class', score: classScore, reasons: classReasons.length ? classReasons : ['no type declarations found'] });

  const seqReasons: string[] = [];
  let seqScore = 0;
  if (totalCalls >= 3) { seqScore += 3; seqReasons.push(`${totalCalls} outbound calls across ${mod.functions.length} units`); }
  if (external.length >= 1 && totalCalls >= 2) { seqScore += 2; seqReasons.push('calls reach imported modules'); }
  if (mod.functions.length >= 2 && totalCalls >= 2) { seqScore += 2; seqReasons.push('multiple units exchange control'); }
  if (mod.functions.some((f) => f.async)) { seqScore += 1; seqReasons.push('asynchronous calls'); }
  candidates.push({ kind: 'sequence', score: seqScore, reasons: seqReasons.length ? seqReasons : ['no inter-unit message flow found'] });

  const stateReasons: string[] = [];
  let stateScore = 0;
  if (statusHits >= 2) { stateScore += 5; stateReasons.push(`${statusHits} status-like literals`); }
  if (mod.types.some((t) => t.kind === 'enum')) { stateScore += 3; stateReasons.push('enumeration of states'); }
  if (guards.length >= 3) { stateScore += 2; stateReasons.push(`${guards.length} guard transitions`); }
  if (controls.filter((c) => c.kind === 'if').length >= 2 &&
    mod.functions.every((f) => f.body.filter((s) => ['for', 'while'].includes(s.kind)).length === 0)) {
    stateScore += 1;
    stateReasons.push('branch-only control flow, no loops');
  }
  candidates.push({ kind: 'state', score: stateScore, reasons: stateReasons.length ? stateReasons : ['no state transitions found'] });

  const actReasons: string[] = [];
  let actScore = 0;
  if (controls.length >= 3) { actScore += 3; actReasons.push(`${controls.length} control-flow nodes`); }
  if (mod.functions.length <= 2) { actScore += 2; actReasons.push('single procedural flow'); }
  if (allStatements.filter((s) => ['for', 'while'].includes(s.kind)).length >= 1) { actScore += 2; actReasons.push('loops present'); }
  if (mod.types.length === 0 && controls.length >= 2) { actScore += 2; actReasons.push('no type model to diagram'); }
  candidates.push({ kind: 'activity', score: actScore, reasons: actReasons.length ? actReasons : ['flow is too small to diagram'] });

  const compReasons: string[] = [];
  let compScore = 0;
  if (external.length >= 3) { compScore += 6; compReasons.push(`${external.length} external modules`); }
  else if (external.length >= 2) { compScore += 2; compReasons.push(`${external.length} external modules`); }
  if (mod.functions.length >= 4) { compScore += 2; compReasons.push('several collaborating units'); }
  if (mod.types.some((t) => t.members.length >= 3)) { compScore += 1; compReasons.push('data-holding components'); }
  candidates.push({ kind: 'component', score: compScore, reasons: compReasons.length ? compReasons : ['no module boundary to show'] });

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const second = candidates[1]?.score ?? 0;
  const confidence = top.score === 0 ? 0.34 : Math.min(0.98, 0.55 + (top.score - second) * 0.11 + Math.min(top.score, 10) * 0.02);
  const selected: UmlKind = top.score === 0 ? 'activity' : top.kind;
  return { selected, confidence: Math.round(confidence * 100) / 100, candidates };
}

function classDiagram(mod: ParsedModule, direction: Direction): string {
  const lines: string[] = ['classDiagram', `  direction ${direction}`];
  for (const type of mod.types) {
    const name = mermaidId(type.name);
    lines.push(`  class ${name} {`);
    if (type.kind) lines.push(`    <<${type.kind}>>`);
    for (const member of type.members.slice(0, 12)) {
      const isMethod = member.name.endsWith('()');
      const label = sanitizeLabel(`${member.name}${member.type ? ` ${member.type}` : ''}`, 48);
      lines.push(`    ${isMethod ? '+' : '+'}${label}`);
    }
    lines.push('  }');
    if (type.extends) lines.push(`  ${mermaidId(type.extends)} <|-- ${name}`);
    for (const impl of type.implements ?? []) lines.push(`  ${mermaidId(impl)} <|.. ${name}`);
  }
  for (const fn of mod.functions.filter((f) => f.isMethod && f.className)) {
    const owner = mermaidId(fn.className!);
    if (!mod.types.some((t) => mermaidId(t.name) === owner)) {
      lines.push(`  class ${owner} {`, '  }');
    }
  }
  if (mod.types.length === 0) lines.push('  class Source {', '    +analyze()', '  }');
  return lines.join('\n');
}

function sequenceDiagram(mod: ParsedModule, direction: Direction): string {
  const participants = new Map<string, string>();
  participants.set('Caller', 'Caller');
  for (const imp of mod.imports.filter((i) => i.external).slice(0, 5)) {
    const id = mermaidId(imp.module.split('/').pop() ?? imp.module);
    participants.set(id, sanitizeLabel(imp.module, 28));
  }
  for (const fn of mod.functions) {
    for (const call of fn.calls.slice(0, 4)) {
      const head = call.split('.')[0];
      if (mod.functions.some((f) => f.name === head)) continue;
      const id = mermaidId(head);
      if (!participants.has(id)) participants.set(id, sanitizeLabel(head, 24));
    }
  }
  if (participants.size === 1) participants.set('Source', 'Source');

  const lines: string[] = ['sequenceDiagram', '  autonumber'];
  for (const [id, label] of participants) lines.push(`  participant ${id} as ${label}`);
  const target = [...participants.keys()].find((k) => k !== 'Caller') ?? 'Caller';
  const ctors: string[] = [];
  for (const fn of mod.functions.slice(0, 8)) {
    const label = sanitizeLabel(`${fn.name}(${fn.params.map((p) => p.name).join(', ')})`, 52);
    lines.push(`  Caller->>${target}: ${label}`);
    for (const call of fn.calls.slice(0, 4)) {
      const head = call.split('.')[0];
      const own = mod.functions.some((f) => f.name === head);
      const id = participants.has(mermaidId(head)) ? mermaidId(head) : target;
      if (mod.functions.some((f) => f.name === call)) {
        lines.push(`  ${target}->>${target}: ${sanitizeLabel(call, 40)}`);
        continue;
      }
      if (own) continue;
      lines.push(`  ${target}->>${id}: ${sanitizeLabel(call, 40)}`);
      if (fn.errors.length) lines.push(`  ${id}-->>${target}: error`);
    }
    if (fn.errors.length) lines.push(`  ${target}-->>Caller: ${sanitizeLabel(fn.errors[0].error, 32)}`);
    else lines.push(`  ${target}-->>Caller: ${fn.returnType ? sanitizeLabel(fn.returnType, 24) : 'done'}`);
  }
  if (mod.functions.length === 0) lines.push('  Caller->>Source: analyze()', '  Source-->>Caller: done');
  if (direction === 'LR') ctors.push('');
  return lines.join('\n');
}

function stateDiagram(mod: ParsedModule, direction: Direction): string {
  const lines: string[] = ['stateDiagram-v2', `  direction ${direction}`];
  const statusLiterals = new Set<string>();
  for (const line of mod.lines) {
    const matches = line.match(/['"]([a-zA-Z][\w-]{2,})['"]/g) ?? [];
    for (const match of matches) {
      const value = match.replace(/['"]/g, '');
      if (STATUS_TOKENS.test(match)) statusLiterals.add(value);
    }
  }
  const states = [...statusLiterals].slice(0, 8).map((s) => mermaidId(s));
  lines.push('  [*] --> Idle');
  if (states.length) {
    let prev = 'Idle';
    for (const state of states) {
      lines.push(`  ${prev} --> ${state}: transition`);
      prev = state;
    }
    lines.push(`  ${prev} --> [*]`);
  } else {
    const fn = mod.functions[0];
    const guard = fn?.guards[0];
    const errorName = fn?.errors[0]?.error ?? 'Rejected';
    lines.push('  Idle --> Processing: request');
    if (guard) lines.push(`  Processing --> ${mermaidId(errorName)}: ${sanitizeLabel(guard.condition, 46)}`);
    lines.push('  Processing --> Completed: success');
    lines.push(`  ${mermaidId(errorName)} --> [*]`);
    lines.push('  Completed --> [*]');
  }
  return lines.join('\n');
}

function activityDiagram(mod: ParsedModule, direction: Direction): string {
  const fn: FunctionInfo | undefined = mod.functions[0];
  const lines: string[] = ['flowchart TD'.replace('TD', direction), '  Start([Start])'];
  if (!fn) {
    lines.push('  Ingest[Ingest source]', '  Analyse[Analyse structure]', '  Emit[Emit documentation]');
    lines.push('  Start --> Ingest --> Analyse --> Emit --> Done([Done])');
    return lines.join('\n');
  }
  let prev = 'Start';
  let counter = 0;
  const nodeId = (prefix: string) => `${prefix}${(counter += 1)}`;
  for (const stmt of fn.body.slice(0, 18)) {
    if (stmt.kind === 'if') {
      const id = nodeId('Cond');
      lines.push(`  ${id}{"${sanitizeLabel(stmt.text.replace(/^if\s*/i, 'If '), 58)}"}`);
      lines.push(`  ${prev} --> ${id}`);
      prev = id;
      continue;
    }
    if (stmt.kind === 'else') {
      const id = nodeId('Else');
      lines.push(`  ${id}["Else"]`);
      lines.push(`  ${prev} -->|no| ${id}`);
      prev = id;
      continue;
    }
    if (stmt.kind === 'for' || stmt.kind === 'while') {
      const id = nodeId('Loop');
      lines.push(`  ${id}["${sanitizeLabel(stmt.text, 52)}"]`);
      lines.push(`  ${prev} --> ${id}`);
      prev = id;
      continue;
    }
    if (stmt.kind === 'throw') {
      const id = nodeId('Err');
      lines.push(`  ${id}["${sanitizeLabel(stmt.text, 48)}"]`);
      lines.push(`  ${prev} --> ${id}`, `  ${id} --> Fail([Error])`);
      continue;
    }
    if (stmt.kind === 'return') {
      const id = nodeId('Ret');
      lines.push(`  ${id}["${sanitizeLabel(stmt.text, 52)}"]`);
      lines.push(`  ${prev} --> ${id}`, `  ${id} --> Done([Done])`);
      continue;
    }
    if (stmt.kind === 'assign' || stmt.kind === 'call' || stmt.kind === 'other') {
      const id = nodeId('Step');
      lines.push(`  ${id}["${sanitizeLabel(stmt.text, 54)}"]`);
      lines.push(`  ${prev} --> ${id}`);
      prev = id;
    }
  }
  if (!lines.some((l) => l.includes('Done([Done])'))) {
    lines.push('  Done([Done])');
    lines.push(`  ${prev} --> Done`);
  }
  return lines.join('\n');
}

function componentDiagram(mod: ParsedModule, direction: Direction): string {
  const lines: string[] = ['flowchart LR'.replace('LR', direction), `  App["${sanitizeLabel(baseName(mod.fileName), 40)}"]`];
  const external = mod.imports.filter((i) => i.external).slice(0, 8);
  for (const imp of external) {
    const id = mermaidId(`ext_${imp.module}`);
    lines.push(`  ${id}["${sanitizeLabel(imp.module, 36)}"]`);
    lines.push(`  App --> ${id}`);
  }
  const locals = mod.imports.filter((i) => !i.external).slice(0, 6);
  for (const imp of locals) {
    const id = mermaidId(`loc_${imp.module}`);
    lines.push(`  ${id}["${sanitizeLabel(imp.module, 36)}"]`);
    lines.push(`  App --> ${id}`);
  }
  if (external.length === 0 && locals.length === 0) {
    lines.push('  Core["Core logic"]', '  App --> Core');
  }
  for (const type of mod.types.slice(0, 5)) {
    const id = mermaidId(`type_${type.name}`);
    lines.push(`  ${id}["${sanitizeLabel(type.name, 30)}"]`);
    lines.push(`  App --> ${id}`);
  }
  return lines.join('\n');
}

export function buildUml(fileName: string, source: string, options: KozueOptions): KozueOutput {
  const mod = parseSource(fileName, source);
  const detection = detectKind(mod);
  const diagram = {
    sequence: sequenceDiagram(mod, options.direction),
    class: classDiagram(mod, options.direction),
    state: stateDiagram(mod, options.direction),
    activity: activityDiagram(mod, options.direction),
    component: componentDiagram(mod, options.direction),
  };
  const activeKind: UmlKind = !options.kind || options.kind === 'auto' ? detection.selected : options.kind;
  return { detection, activeKind, mermaid: diagram, autoSelection: detection.selected };
}

export class KozueAdapter implements EngineAdapter<KozueOutput, KozueOptions> {
  readonly id = 'kozue' as const;
  readonly title = 'UML Auto-Architect';
  readonly japaneseTitle = '梢絵';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    'Automatic UML kind selection with reasons and confidence',
    'Sequence, Class, State, Activity and Component diagrams',
    'Mermaid rendering with zoom and pan',
    'SVG and PNG export, .mmd copy, TD/LR direction',
  ] as const;

  async run(request: EngineRequest<KozueOptions>): Promise<EngineResult<KozueOutput>> {
    const started = performance.now();
    const options: KozueOptions = {
      kind: request.options?.kind ?? 'auto',
      direction: request.options?.direction ?? 'TD',
    };
    const output = buildUml(request.sourceName, request.source, options);
    const cacheKey = await sha256Hex(`${this.id}|${request.mode}|${request.source}|${options.kind}|${options.direction}`);
    return {
      output,
      providerMode: this.providerMode,
      diagnostics: [],
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}
