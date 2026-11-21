import { describe, expect, it } from 'vitest';
import { detectLanguage, parseSource } from '../src/lib/source';
import { GO_SAMPLE, JAVA_SAMPLE, PY_SAMPLE, TS_SAMPLE } from '../src/tools/samples';

describe('language detection', () => {
  it('detects by extension', () => {
    expect(detectLanguage('a.ts', '')).toBe('typescript');
    expect(detectLanguage('a.py', '')).toBe('python');
    expect(detectLanguage('A.java', '')).toBe('java');
    expect(detectLanguage('a.go', '')).toBe('go');
  });

  it('detects by content when the extension is unknown', () => {
    expect(detectLanguage('snippet.txt', 'package main\n\nfunc main() {\n}\n')).toBe('go');
    expect(detectLanguage('snippet.txt', 'def run(x):\n    return x\n')).toBe('python');
  });
});

describe('TypeScript model', () => {
  const mod = parseSource('payment-service.ts', TS_SAMPLE);

  it('finds types, functions and imports', () => {
    expect(mod.language).toBe('typescript');
    expect(mod.types.map((t) => t.name)).toEqual(expect.arrayContaining(['PaymentRequest', 'PaymentResult', 'PaymentService']));
    expect(mod.functions.map((f) => f.name)).toEqual(
      expect.arrayContaining(['constructor', 'charge', 'callGateway', 'reconcileBatch']),
    );
    expect(mod.imports.some((i) => i.module === './invoice-repository' && !i.external)).toBe(true);
    expect(mod.imports.some((i) => i.module === 'crypto' && i.external)).toBe(true);
  });

  it('extracts parameters, defaults and return types', () => {
    const charge = mod.functions.find((f) => f.name === 'charge')!;
    expect(charge.params[0]).toMatchObject({ name: 'request', type: 'PaymentRequest' });
    expect(charge.returnType).toBe('Promise<PaymentResult>');
    expect(charge.async).toBe(true);
    expect(charge.isMethod).toBe(true);
    expect(charge.className).toBe('PaymentService');

    const interfaceMembers = mod.types.find((t) => t.name === 'PaymentRequest')!.members;
    expect(interfaceMembers.map((m) => m.name)).toEqual(['invoiceId', 'amount', 'currency', 'retry']);
  });

  it('separates guard clauses from thrown errors', () => {
    const charge = mod.functions.find((f) => f.name === 'charge')!;
    expect(charge.guards.length).toBeGreaterThanOrEqual(4);
    expect(charge.guards.some((g) => g.condition.includes('amount <= 0'))).toBe(true);
    expect(charge.guards.every((g) => ['return', 'throw', 'continue', 'break'].includes(g.action))).toBe(true);
    expect(charge.errors.length).toBeGreaterThanOrEqual(3);
    expect(charge.errors.some((e) => e.error === 'Error')).toBe(true);
  });

  it('records method line ranges', () => {
    const charge = mod.functions.find((f) => f.name === 'charge')!;
    expect(charge.startLine).toBeLessThan(charge.endLine);
    expect(mod.lines[charge.startLine - 1]).toContain('charge');
  });
});

describe('Python model', () => {
  const mod = parseSource('account_service.py', PY_SAMPLE);

  it('reads defaults, return annotations and dataclass fields', () => {
    const register = mod.functions.find((f) => f.name === 'register')!;
    expect(register.params[1]).toMatchObject({ name: 'role', type: 'str', defaultValue: '"viewer"' });
    expect(register.returnType).toBe('Account');

    const account = mod.types.find((t) => t.name === 'Account')!;
    expect(account.members.map((m) => m.name)).toEqual(expect.arrayContaining(['email', 'role', 'active']));
  });

  it('maps raise statements to error paths', () => {
    const register = mod.functions.find((f) => f.name === 'register')!;
    expect(register.guards.length).toBeGreaterThanOrEqual(2);
    expect(register.errors.map((e) => e.error)).toContain('ValueError');
    expect(register.guards.every((g) => g.action !== 'throw' || g.condition.length > 0)).toBe(true);
  });
});

describe('Java and Go models', () => {
  it('parses a Java class without mistaking the constructor for a return type', () => {
    const mod = parseSource('InvoiceService.java', JAVA_SAMPLE);
    const ctor = mod.functions.find((f) => f.name === 'InvoiceService')!;
    expect(ctor.returnType).toBeUndefined();
    const create = mod.functions.find((f) => f.name === 'create')!;
    expect(create.returnType).toBe('Invoice');
    expect(create.params.map((p) => p.name)).toEqual(['customerId', 'lines']);
    expect(create.guards.length).toBeGreaterThanOrEqual(3);
  });

  it('parses Go receivers, structs and error returns', () => {
    const mod = parseSource('billing_service.go', GO_SAMPLE);
    const charge = mod.functions.find((f) => f.name === 'Charge')!;
    expect(charge.isMethod).toBe(true);
    expect(charge.className).toBe('Service');
    expect(charge.returnType).toContain('error');
    expect(charge.guards.length).toBeGreaterThanOrEqual(3);
    expect(mod.types.map((t) => t.name)).toEqual(expect.arrayContaining(['Charge', 'Gateway', 'Service']));
  });
});
