import { describe, expect, it } from 'vitest';
import {
  buildTakane,
  generateCode,
  parseSignature,
  parseSpecMarkdown,
  type TakaneLanguage,
} from '../src/tools/takane/adapter';
import { CACHE_SPEC, ORDER_SPEC, PAYMENT_SPEC } from '../src/tools/takane/samples';
import { ShioriAdapter } from '../src/tools/shiori/adapter';
import { TS_SAMPLE } from '../src/tools/samples';

const generate = (language: TakaneLanguage, spec = PAYMENT_SPEC) =>
  buildTakane('payment-service.spec.md', spec, language);

describe('Takane specification parser', () => {
  it('reads a Shiori-shaped specification into contracts, types and guards', () => {
    const model = parseSpecMarkdown(PAYMENT_SPEC, 'payment-service.spec.md');
    expect(model.title).toBe('payment-service');
    expect(model.contracts.map((contract) => contract.name)).toEqual(['charge', 'refund', 'quote']);
    expect(model.contracts[0].owner).toBe('PaymentService');
    expect(model.contracts[0].params).toEqual([
      { name: 'request', type: 'PaymentRequest', optional: false, defaultValue: undefined },
    ]);
    expect(model.contracts[0].returns).toBe('Promise<PaymentResult>');
    expect(model.contracts[0].async).toBe(true);
    expect(model.contracts[2].params[1]).toMatchObject({ name: 'currency', type: 'string', optional: true });
    expect(model.types.map((type) => `${type.kind}:${type.name}`)).toEqual([
      'interface:PaymentRequest',
      'type:PaymentResult',
      'enum:PaymentStatus',
    ]);
    expect(model.types[0].fields).toEqual([
      { name: 'invoiceId', type: 'string', optional: false },
      { name: 'amount', type: 'number', optional: false },
      { name: 'currency', type: 'string', optional: true },
      { name: 'retry', type: 'boolean', optional: true },
    ]);
    expect(model.guards).toHaveLength(4);
    expect(model.guards[0]).toMatchObject({ target: 'charge', condition: '!request.invoiceId', action: 'throw' });
    expect(model.guards[0].message).toBe('invoiceId is required');
    expect(model.errorPaths).toHaveLength(2);
  });

  it('reads a plain Markdown specification with tables and bullets', () => {
    const model = parseSpecMarkdown(ORDER_SPEC, 'order-workflow.spec.md');
    expect(model.contracts.map((contract) => contract.name)).toEqual(['cancel', 'complete', 'addLine']);
    expect(model.contracts[0].visibility).toBe('public');
    expect(model.types.map((type) => type.name)).toEqual(['OrderLine', 'OrderState']);
    expect(model.types[1].fields.at(-2)).toEqual({ name: 'lines', type: 'OrderLine[]', optional: false });
    expect(model.guards).toHaveLength(4);
    expect(model.errorPaths).toHaveLength(3);
  });

  it('reads declarations from a fenced code block together with owner classes', () => {
    const model = parseSpecMarkdown(CACHE_SPEC, 'cache-store.spec.md');
    expect(model.types.map((type) => type.name)).toEqual(['CacheEntry', 'CacheStats', 'PruneResult']);
    expect(model.contracts.map((contract) => `${contract.owner ?? ''}.${contract.name}`)).toEqual([
      'CacheStore.get',
      'CacheStore.set',
      'CacheStore.prune',
    ]);
    expect(model.contracts[0].returns).toBe('Promise<CacheEntry | undefined>');
    expect(model.guards.map((guard) => guard.target)).toEqual(['CacheStore.get', 'CacheStore.set', 'CacheStore.set']);
  });

  it('parses Java-style signatures and default values', () => {
    expect(parseSignature('public CompletableFuture<Receipt> pay(ReceiptRequest request, int retries)')).toMatchObject({
      name: 'pay',
      returns: 'CompletableFuture<Receipt>',
      async: true,
    });
    expect(parseSignature('def charge(request: PaymentRequest, retries: int = 3) -> PaymentResult:')?.params[1]).toEqual({
      name: 'retries',
      type: 'int',
      optional: true,
      defaultValue: '3',
    });
  });

  it('reports an empty specification instead of inventing contracts', () => {
    const model = parseSpecMarkdown('# Only a title\n\nSome prose without declarations.\n', 'empty.md');
    expect(model.contracts).toHaveLength(0);
    expect(model.types).toHaveLength(0);
    expect(model.notes.length).toBeGreaterThan(0);
  });
});

describe('Takane code generation', () => {
  it('generates TypeScript types, class methods, guards and JSDoc', () => {
    const output = generate('typescript');
    expect(output.fileName).toBe('payment_service.ts');
    expect(output.stats).toMatchObject({ types: 3, methods: 3, guards: 4, errors: 2 });
    expect(output.code).toContain('export interface PaymentRequest {');
    expect(output.code).toContain('  currency?: string;');
    expect(output.code).toContain('export enum PaymentStatus {');
    expect(output.code).toContain('export class PaymentService {');
    expect(output.code).toContain('async charge(request: PaymentRequest): Promise<PaymentResult> {');
    expect(output.code).toContain('export async function refund(invoiceId: string, amount: number): Promise<RefundResult> {');
    expect(output.code).toContain('export function quote(amount: number, currency?: string): Quote {');
    expect(output.code).toContain('if (!request.invoiceId) {');
    expect(output.code).toContain("throw new Error('invoiceId is required');");
    expect(output.code).toContain('// TODO: implement charge.');
    expect(output.code).toContain('@returns Promise<PaymentResult>');
  });

  it('generates Python dataclasses, snake_case members and typed methods', () => {
    const output = generate('python');
    expect(output.fileName).toBe('payment_service.py');
    expect(output.code).toContain('@dataclass');
    expect(output.code).toContain('class PaymentRequest:');
    expect(output.code).toContain('    invoice_id: str');
    expect(output.code).toContain('    currency: str | None = None');
    expect(output.code).toContain('class PaymentService:');
    expect(output.code).toContain('    def charge(self, request: PaymentRequest) -> "PaymentResult":');
    expect(output.code).toContain('        if not request.invoice_id:');
    expect(output.code).toContain('raise ValueError("invoiceId is required")');
    expect(output.code).toContain('from __future__ import annotations');
  });

  it('generates Java classes, records of fields and blank-guards', () => {
    const output = generate('java');
    expect(output.fileName).toBe('PaymentService.java');
    expect(output.code).toContain('public final class PaymentRequest {');
    expect(output.code).toContain('    public final String invoiceId;');
    expect(output.code).toContain('public CompletableFuture<PaymentResult> charge(PaymentRequest request) {');
    expect(output.code).toContain('if (Guards.isBlank(request.invoiceId)) {');
    expect(output.code).toContain('throw new IllegalArgumentException("invoiceId is required");');
    expect(output.code).toContain('static boolean isBlank(Object value)');
  });

  it('generates Go structs, exported methods and error returns', () => {
    const output = generate('go');
    expect(output.fileName).toBe('payment_service.go');
    expect(output.code).toContain('package payment_service');
    expect(output.code).toContain('type PaymentRequest struct {');
    expect(output.code).toContain('\tInvoiceID string');
    expect(output.code).toContain('\tCurrency  *string');
    expect(output.code).toContain('func (service *PaymentService) Charge(ctx context.Context, request PaymentRequest) (PaymentResult, error) {');
    expect(output.code).toContain('if isZero(request.InvoiceID) {');
    expect(output.code).toContain('fmt.Errorf("invoiceId is required")');
    expect(output.code).toContain('func isZero[T comparable](value T) bool {');
    expect(output.code).toContain('return PaymentResult{}, fmt.Errorf("not implemented: PaymentService.charge")');
  });

  it('keeps every generated artifact in English', () => {
    for (const language of ['typescript', 'python', 'java', 'go'] as TakaneLanguage[]) {
      const { code } = generateCode(parseSpecMarkdown(PAYMENT_SPEC, 'payment-service.spec.md'), language);
      expect(code).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/);
    }
  });
});

describe('Shiori to Takane round trip', () => {
  it('turns a Shiori specification back into a code scaffold', async () => {
    const shiori = new ShioriAdapter();
    const result = await shiori.run({
      toolId: 'shiori',
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options: { includePrivate: true, sections: ['overview', 'contracts', 'behaviour', 'errors', 'dependencies', 'types'] },
      mode: 'local-static',
    });
    const spec = result.output.markdown;
    expect(spec).toContain('# Specification — payment-service');

    const model = parseSpecMarkdown(spec, 'payment-service.spec.md');
    expect(model.contracts.some((contract) => contract.name === 'charge')).toBe(true);

    const typescript = buildTakane('payment-service.spec.md', spec, 'typescript');
    expect(typescript.code).toContain('export class PaymentService {');
    expect(typescript.code).toContain('async charge(request: PaymentRequest): Promise<PaymentResult> {');
    expect(typescript.code).toContain('export interface PaymentRequest {');
    expect(typescript.stats.methods).toBeGreaterThan(0);

    const python = buildTakane('payment-service.spec.md', spec, 'python');
    expect(python.code).toContain('def charge(self, request: PaymentRequest)');
  });
});
