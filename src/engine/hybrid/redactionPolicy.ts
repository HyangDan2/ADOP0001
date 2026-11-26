/**
 * INT-007 — the operator's own redaction policy.
 *
 * The built-in patterns cover key-shaped material, but an organisation has its own
 * identifiers (an employee number, an internal ticket prefix, a customer code).
 * Phase 5C.1 could register a pattern only from code. This module makes the policy
 * a preference:
 *
 * - `customPatterns` — extra expressions, applied after the built-ins;
 * - `disabled` — built-in ids the operator switched off (a false positive on their
 *   own file format is a reason to switch one off, not to stop redacting);
 * - the policy is validated before it is stored, so an unsafe expression never
 *   reaches the tab's request path;
 * - it is a preference, not a secret: no key material is accepted here, and the
 *   stored record is an explicit field list.
 */
import { hybridConfig } from './config';
import { redactText, unsafePatternReason, type CustomRedactionPattern, type RedactionOptions } from './redaction';
import { redactionRegistry } from './redaction';

export const REDACTION_POLICY_KEY = 'adop0001.hybrid.redaction.v1';

export interface RedactionPolicy {
  customPatterns: CustomRedactionPattern[];
  disabled: string[];
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = { customPatterns: [], disabled: [] };

export interface RedactionPolicyProblem {
  id: string;
  message: string;
}

export interface RedactionPolicyValidation {
  ok: boolean;
  policy: RedactionPolicy;
  problems: RedactionPolicyProblem[];
}

/** Coerces a stored/form value into a valid policy; every problem is reported. */
export function validateRedactionPolicy(raw: unknown): RedactionPolicyValidation {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<RedactionPolicy>;
  const problems: RedactionPolicyProblem[] = [];
  const limit = hybridConfig.read().redaction.maxPatterns;

  const customPatterns: CustomRedactionPattern[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(record.customPatterns) ? record.customPatterns : []) {
    if (!entry || typeof entry !== 'object') {
      problems.push({ id: '(unknown)', message: 'カスタム伏字パターンの形式が正しくありません。' });
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const pattern = typeof entry.pattern === 'string' ? entry.pattern : '';
    if (!id) {
      problems.push({ id: '(no id)', message: 'カスタム伏字パターンに名前がありません。' });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ id, message: '同じ名前のカスタム伏字パターンが重複しています。' });
      continue;
    }
    const unsafe = unsafePatternReason(pattern);
    if (unsafe) {
      problems.push({ id, message: unsafe });
      continue;
    }
    seen.add(id);
    customPatterns.push({
      id,
      pattern,
      flags: typeof entry.flags === 'string' ? entry.flags.replace(/[gy]/g, '') : undefined,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 80) : undefined,
    });
  }
  if (customPatterns.length > limit) {
    problems.push({ id: '(all)', message: `カスタム伏字パターンは ${limit} 件までです。` });
  }

  const known = new Set(redactionRegistry.ids());
  const disabled: string[] = [];
  for (const id of Array.isArray(record.disabled) ? record.disabled : []) {
    if (typeof id !== 'string' || !id.trim()) continue;
    if (!known.has(id)) {
      problems.push({ id, message: '無効化しようとした伏字ルールが見つかりません。' });
      continue;
    }
    disabled.push(id);
  }

  return {
    ok: problems.length === 0,
    policy: { customPatterns, disabled },
    problems,
  };
}

/** One text line (`name=regex`) → a custom pattern, for the settings panel. */
export function patternFromLine(line: string): CustomRedactionPattern | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf('=');
  if (separator <= 0) return null;
  const id = trimmed.slice(0, separator).trim();
  const pattern = trimmed.slice(separator + 1).trim();
  if (!id || !pattern) return null;
  return { id, pattern, label: id };
}

export function patternToLine(pattern: CustomRedactionPattern): string {
  return `${pattern.id}=${pattern.pattern}`;
}

/** A policy with a `test` preview, so the panel can show what it removes. */
export function previewRedaction(policy: RedactionPolicy, sample: string): { text: string; total: number } {
  const options: RedactionOptions = { customPatterns: policy.customPatterns, disabled: policy.disabled };
  const result = redactText(sample, options);
  return { text: result.text, total: result.counts.total };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export interface RedactionPolicyStore {
  read(): RedactionPolicy;
  write(policy: RedactionPolicy): { ok: boolean; error: string | null; problems: RedactionPolicyProblem[] };
}

export function createRedactionPolicyStore(storage: StorageLike | null = defaultStorage()): RedactionPolicyStore {
  return {
    read() {
      if (!storage) return { ...DEFAULT_REDACTION_POLICY };
      try {
        const raw = storage.getItem(REDACTION_POLICY_KEY);
        if (!raw) return { ...DEFAULT_REDACTION_POLICY };
        return validateRedactionPolicy(JSON.parse(raw)).policy;
      } catch {
        return { ...DEFAULT_REDACTION_POLICY };
      }
    },
    write(policy) {
      const validation = validateRedactionPolicy(policy);
      if (!validation.ok) {
        return { ok: false, error: validation.problems[0]?.message ?? '伏字ポリシーを保存できません。', problems: validation.problems };
      }
      if (!storage) return { ok: false, error: 'このブラウザに伏字ポリシーを保存できません。', problems: [] };
      try {
        storage.setItem(
          REDACTION_POLICY_KEY,
          JSON.stringify({
            customPatterns: validation.policy.customPatterns,
            disabled: validation.policy.disabled,
          }),
        );
        return { ok: true, error: null, problems: [] };
      } catch {
        return { ok: false, error: '伏字ポリシーを保存できませんでした（保存領域がいっぱいか、書き込みが拒否されました）。', problems: [] };
      }
    },
  };
}

export const redactionPolicyStore = createRedactionPolicyStore();
