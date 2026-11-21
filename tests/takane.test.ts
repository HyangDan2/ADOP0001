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
  it('keeps Python dataclasses, snake_case members and typed methods', () => {
    const output = generate('python');
    expect(output.fileName).toBe('payment_service.py');
    expect(output.stats).toMatchObject({ types: 3, methods: 3, guards: 4, errors: 2 });
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

  it('emits a C11 header with structs, enums, prototypes and negative status codes', () => {
    const output = generate('c');
    expect(output.fileName).toBe('payment_service.c');
    expect(output.code).toContain('#ifndef PAYMENT_SERVICE_H');
    expect(output.code).toContain('#include <stdint.h>');
    expect(output.code).toContain('PAYMENT_SERVICE_OK = 0,');
    expect(output.code).toContain('PAYMENT_SERVICE_ERR_INVALID_ARG = -1,');
    expect(output.code).toContain('typedef struct PaymentRequest {');
    expect(output.code).toContain('    const char *invoice_id;');
    expect(output.code).toContain('    double amount;');
    expect(output.code).toContain('    PaymentStatus status;');
    expect(output.code).toContain('PaymentServiceStatus payment_service_charge(const PaymentRequest *request, PaymentResult *out);');
    expect(output.code).toContain('if (request->invoice_id == NULL) {');
    expect(output.code).toContain('return PAYMENT_SERVICE_ERR_INVALID_ARG; /* invoiceId is required */');
    expect(output.code).toContain('/* TODO: implement PaymentService.charge. */');
    expect(output.code).toContain('return PAYMENT_SERVICE_ERR_UNIMPLEMENTED;');
    expect(output.code).toContain('@param[out] out Receives the PaymentResult result.');
    // Generated C never allocates and never declares a class.
    expect(output.code).not.toContain('malloc(');
    expect(output.code).not.toContain('class ');
  });

  it('emits a C++17 header with enum class, std::optional and stdexcept guards', () => {
    const output = generate('cpp');
    expect(output.fileName).toBe('payment_service.cpp');
    expect(output.code).toContain('#pragma once');
    expect(output.code).toContain('namespace payment_service {');
    expect(output.code).toContain('enum class PaymentStatus {');
    expect(output.code).toContain('    std::optional<std::string> currency{};');
    expect(output.code).toContain('struct PaymentRequest {');
    expect(output.code).toContain('class PaymentService {');
    expect(output.code).toContain('PaymentResult charge(const PaymentRequest &request) {');
    expect(output.code).toContain('if (request.invoice_id.empty()) {');
    expect(output.code).toContain('throw std::invalid_argument("invoiceId is required");');
    expect(output.code).toContain('throw std::runtime_error("not implemented: PaymentService.charge");');
    expect(output.code).toContain('#include <stdexcept>');
  });

  it('emits MCU C with fixed-width integers, static buffers and MCU status codes', () => {
    const output = generate('mcu');
    expect(output.fileName).toBe('payment_service_mcu.c');
    expect(output.code).toContain('#ifndef PAYMENT_SERVICE_MCU_H');
    expect(output.code).toContain('MCU_OK = 0,');
    expect(output.code).toContain('MCU_ERR_INVALID_ARG = -1,');
    expect(output.code).toContain('MCU_ERR_UNIMPLEMENTED = -2');
    expect(output.code).toContain('typedef uint8_t McuStatusByte;');
    expect(output.code).toContain('sizeof(uint16_t) == 2U');
    expect(output.code).toContain('    char invoice_id[PAYMENT_REQUEST_TEXT_MAX];');
    expect(output.code).toContain('    int32_t amount;');
    expect(output.code).toContain("if (request->invoice_id[0] == '\\0') {");
    expect(output.code).toContain('return MCU_ERR_INVALID_ARG;');
    expect(output.code).toContain('return MCU_ERR_UNIMPLEMENTED;');
    expect(output.code).not.toContain('malloc(');
    expect(output.code).not.toContain('#include <stdlib.h>');
  });

  it('maps array fields to fixed buffers with a count on the MCU target', () => {
    const output = buildTakane('order-workflow.spec.md', ORDER_SPEC, 'mcu');
    expect(output.code).toContain('    OrderLine lines[ORDER_STATE_ITEMS_MAX];');
    expect(output.code).toContain('    size_t lines_count;');
    expect(output.code).toContain('McuStatus cancel(const char *order_id, const char *reason, OrderState *out);');
    expect(output.code).toContain("if (order_id[0] == '\\0') {");
  });

  it('keeps every generated artifact in English', () => {
    for (const language of ['python', 'c', 'cpp', 'mcu'] as TakaneLanguage[]) {
      const { code } = generateCode(parseSpecMarkdown(PAYMENT_SPEC, 'payment-service.spec.md'), language);
      expect(code).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/);
    }
  });

  it('reports an untouched guard as a TODO instead of inventing C code', () => {
    const output = generate('c');
    expect(output.code).toContain('/* TODO: guard "!SUPPORTED_CURRENCIES.includes(currency)" could not be translated to C. */');
  });
});

describe('Takane language surface', () => {
  it('offers exactly Python, C, C++ and MCU', () => {
    for (const language of ['python', 'c', 'cpp', 'mcu'] as TakaneLanguage[]) {
      const { fileName } = generateCode(parseSpecMarkdown(PAYMENT_SPEC, 'payment-service.spec.md'), language);
      expect(fileName).toMatch(/\.(py|c|cpp)$/);
    }
    const extensions = (['python', 'c', 'cpp', 'mcu'] as TakaneLanguage[]).map(
      (language) => generate(language).fileName,
    );
    expect(extensions).toEqual(['payment_service.py', 'payment_service.c', 'payment_service.cpp', 'payment_service_mcu.c']);
  });
});

describe('Shiori to Takane round trip', () => {
  it('turns a Shiori specification back into Python and C scaffolds', async () => {
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

    const python = buildTakane('payment-service.spec.md', spec, 'python');
    expect(python.code).toContain('def charge(self, request: PaymentRequest)');
    expect(python.stats.methods).toBeGreaterThan(0);

    const c = buildTakane('payment-service.spec.md', spec, 'c');
    expect(c.code).toContain('typedef struct PaymentRequest {');

    const cpp = buildTakane('payment-service.spec.md', spec, 'cpp');
    expect(cpp.code).toContain('PaymentResult charge(const PaymentRequest &request)');

    const mcu = buildTakane('payment-service.spec.md', spec, 'mcu');
    expect(mcu.code).toContain('MCU_ERR_UNIMPLEMENTED');
  });
});
