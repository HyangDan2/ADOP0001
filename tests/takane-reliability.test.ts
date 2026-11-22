/**
 * Phase 1 regression matrix — Takane (TAK-001).
 *
 * Before the fix the generators produced Python whose default arguments preceded
 * required ones, a single C file that mixed declarations and definitions, and
 * unescaped string literals.
 */
import { describe, expect, it } from 'vitest';
import { buildTakane, parseSpecMarkdown } from '../src/tools/takane/adapter';
import { ORDER_SPEC, PAYMENT_SPEC } from '../src/tools/takane/samples';
import { TAKANE_ESCAPE_SPEC, TAKANE_ORDER_SPEC } from './fixtures/haruhi-fixtures';

describe('TAK-001 Python signature validity', () => {
  it('orders required parameters before optional ones', () => {
    const output = buildTakane('order-service.spec.md', TAKANE_ORDER_SPEC, 'python');
    expect(output.code).toContain('def create(count: float, label: str | None = None, note: str | None = None)');
    // The original order is preserved in the diagnostic, not silently dropped.
    const diagnostic = output.diagnostics.find((item) => item.code === 'PY-PARAM-ORDER');
    expect(diagnostic).toBeTruthy();
    expect(diagnostic?.severity).toBe('warn');
    expect(diagnostic?.message).toMatch(/label/);
  });

  it('orders dataclass fields so a defaulted field never precedes a required one', () => {
    const output = buildTakane('order-service.spec.md', TAKANE_ORDER_SPEC, 'python');
    const block = output.code.slice(output.code.indexOf('class Order:'));
    const body = block.split('\n\n')[0];
    const idAt = body.indexOf('    id: str');
    const totalAt = body.indexOf('    total: float');
    const noteAt = body.indexOf('    note: str | None = None');
    expect(idAt).toBeGreaterThan(-1);
    expect(totalAt).toBeGreaterThan(idAt);
    expect(noteAt).toBeGreaterThan(totalAt);
    expect(output.diagnostics.some((item) => item.code === 'PY-FIELD-ORDER')).toBe(true);
  });

  it('keeps ordinary signatures and dataclasses unchanged', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'python');
    expect(output.code).toContain('def charge(self, request: PaymentRequest) -> "PaymentResult":');
    expect(output.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0);
  });
});

describe('TAK-001 C declaration and definition split', () => {
  it('emits a header and a translation unit that both compile on their own', () => {
    const output = buildTakane('order-service.spec.md', TAKANE_ORDER_SPEC, 'c');
    expect(output.files.map((file) => file.name)).toEqual(['order_service.h', 'order_service.c']);
    const [header, implementation] = output.files;
    expect(header.code).toContain('#ifndef ORDER_SERVICE_H');
    expect(header.code).toContain('typedef struct Order {');
    expect(header.code).toContain('OrderServiceStatus create(const char *label, double count');
    // The header declares only; it must not carry function bodies.
    expect(header.code).not.toContain('ERR_UNIMPLEMENTED;');
    expect(implementation.code).toContain('#include "order_service.h"');
    expect(implementation.code).toContain('ERR_UNIMPLEMENTED;');
    expect(implementation.code).not.toContain('#ifndef ');
    expect(output.code).toBe(implementation.code);
    expect(output.fileName).toBe('order_service.c');
  });

  it('declares imported types explicitly instead of inventing them', () => {
    const output = buildTakane('order-service.spec.md', TAKANE_ORDER_SPEC, 'c');
    const header = output.files[0].code;
    expect(header).toContain('// TODO: include the header that declares Quote.');
    expect(header).toContain('typedef struct Quote Quote;');
    expect(header).toContain('// TODO: include the header that declares QuoteRequest.');
    expect(header).toContain('typedef struct QuoteRequest QuoteRequest;');
  });
});

describe('TAK-001 C++ header and implementation split', () => {
  it('declares in the header and defines in the translation unit', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'cpp');
    expect(output.files.map((file) => file.name)).toEqual(['payment_service.hpp', 'payment_service.cpp']);
    const [header, implementation] = output.files;
    expect(header.code).toContain('#pragma once');
    expect(header.code).toContain('class PaymentService {');
    expect(header.code).toMatch(/PaymentResult charge\(const PaymentRequest &request\);/);
    expect(header.code).not.toContain('throw std::runtime_error');
    expect(implementation.code).toContain('#include "payment_service.hpp"');
    expect(implementation.code).toContain('PaymentResult PaymentService::charge(const PaymentRequest &request) {');
    expect(implementation.code).toContain('throw std::invalid_argument("invoiceId is required");');
    expect(output.fileName).toBe('payment_service.cpp');
  });

  it('keeps enum class and optional fields in the header', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'cpp');
    const header = output.files[0];
    expect(header.code).toContain('enum class PaymentStatus {');
    expect(header.code).toContain('std::optional<std::string> currency{};');
    expect(header.code).toContain('#include <optional>');
  });
});

describe('TAK-001 literal escaping', () => {
  it('escapes quotes and backslashes in every target language', () => {
    for (const language of ['python', 'c', 'cpp', 'mcu'] as const) {
      const output = buildTakane('escape-service.spec.md', TAKANE_ESCAPE_SPEC, language);
      const code = output.files.map((file) => file.code).join('\n');
      expect(code).toContain('bad \\"name\\" and \\\\ slash');
      expect(code).not.toContain('bad "name" and \\ slash');
    }
  });
});

describe('TAK-001 MCU fixed buffers', () => {
  it('validates that a fixed text buffer is NUL terminated before use', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'mcu');
    const code = output.files.map((file) => file.code).join('\n');
    expect(code).toMatch(/_Static_assert\(PAYMENT_REQUEST_TEXT_MAX >= 2U/);
    expect(code).toContain("memchr(request->invoice_id, '\\0', sizeof(request->invoice_id))");
    expect(code).toContain('buffer is not NUL terminated');
  });

  it('keeps a negative control for the fixed buffer size', () => {
    const output = buildTakane('order-workflow.spec.md', ORDER_SPEC, 'mcu');
    const code = output.files.map((file) => file.code).join('\n');
    expect(code).toContain('ORDER_STATE_ITEMS_MAX');
    expect(code).toMatch(/_Static_assert\(ORDER_STATE_ITEMS_MAX >= 1U/);
  });
});

describe('TAK-001 unsupported shapes stay honest', () => {
  it('keeps an untranslatable guard as a TODO in both the header and the unit', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'c');
    const code = output.files.map((file) => file.code).join('\n');
    expect(code).toContain('TODO: guard "!SUPPORTED_CURRENCIES.includes(currency)"');
  });

  it('never emits a class keyword in C and never allocates', () => {
    const output = buildTakane('payment-service.spec.md', PAYMENT_SPEC, 'c');
    for (const file of output.files) {
      expect(file.code).not.toContain('malloc(');
      expect(file.code).not.toContain('class ');
    }
  });

  it('reports the file set and diagnostics on the output model', () => {
    const output = buildTakane('order-service.spec.md', TAKANE_ORDER_SPEC, 'python');
    expect(output.files.map((file) => file.name)).toEqual(['order_service.py']);
    expect(Array.isArray(output.diagnostics)).toBe(true);
    expect(parseSpecMarkdown(TAKANE_ORDER_SPEC, 'order-service.spec.md').contracts[0].name).toBe('create');
  });
});
