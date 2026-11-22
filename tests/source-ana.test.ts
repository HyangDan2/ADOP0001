/**
 * ANA-001 — shared static parser accuracy.
 *
 * Every fixture below is written the way a real project writes it (a callback
 * parameter type, a nested generic, a multi-line signature, a URL in a string)
 * and the assertions describe what the Phase 3 parser must extract. A case that
 * the heuristics cannot support has to leave a diagnostic instead of vanishing.
 */
import { describe, expect, it } from 'vitest';
import { detectLanguage, languageLabel, parseSource, type FunctionInfo } from '../src/lib/source';

const fn = (functions: FunctionInfo[], name: string, owner?: string) =>
  functions.find((item) => item.name === name && (owner === undefined || item.className === owner));

const GENERIC_SERVICE = `import { Repository } from './repository';
import type { Logger } from './logger';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type Handler<T> = (item: T, index: number) => Promise<T>;

export interface Cache<T> extends Map<string, T> {
  readonly capacity: number;
  getOrLoad(key: string, loader: () => Promise<T>): Promise<T>;
}

export class Pipeline<T extends { id: string }> {
  private readonly cache = new Map<string, Array<T>>();

  constructor(private readonly repository: Repository<T>, logger?: Logger) {
    this.repository = repository;
  }

  async run<U>(items: T[], transform: (item: T) => U = ((item) => item as unknown as U)): Promise<Result<U, Error>> {
    if (!items.length) {
      throw new RangeError('items must not be empty');
    }
    const mapped = await Promise.all(items.map(async (item) => transform(item)));
    return { ok: true, value: mapped[0] as unknown as U };
  }

  static fromList<T extends { id: string }>(items: T[]): Pipeline<T> {
    return new Pipeline<T>(items as never);
  }

  get size(): number {
    return this.cache.size;
  }
}

export const createPipeline = <T extends { id: string }>(items: T[]): Pipeline<T> => new Pipeline<T>(items as never);

export default async function bootstrap(options: { retries?: number } = {}): Promise<void> {
  const pipeline = createPipeline([{ id: 'a' }]);
  if (options.retries !== undefined) {
    throw new Error('retries are not supported yet');
  }
  await pipeline.run([], (item) => item.id);
}`;

describe('ANA-001 TypeScript declarations', () => {
  const mod = parseSource('pipeline.ts', GENERIC_SERVICE);

  it('reads nested generics, union types and type parameters', () => {
    const run = fn(mod.functions, 'run', 'Pipeline')!;
    expect(run.returnType).toBe('Promise<Result<U, Error>>');
    expect(run.typeParameters).toBe('U');
    expect(run.async).toBe(true);
    expect(run.params.map((param) => param.name)).toEqual(['items', 'transform']);
    expect(run.params[1].type).toBe('(item: T) => U');
    expect(run.params[1].defaultValue).toContain('item');
  });

  it('reads a function-type parameter without losing the rest of the list', () => {
    const run = fn(mod.functions, 'run', 'Pipeline')!;
    expect(run.params).toHaveLength(2);
    expect(run.guards.some((guard) => guard.condition.includes('items.length'))).toBe(true);
    expect(run.errors.map((error) => error.error)).toContain('RangeError');
  });

  it('reads constructors, static methods, getters and class fields', () => {
    const ctor = fn(mod.functions, 'constructor', 'Pipeline')!;
    expect(ctor.params.map((param) => param.name)).toEqual(['repository', 'logger']);
    expect(ctor.params[0].type).toBe('Repository<T>');
    expect(ctor.params[1].optional).toBe(true);

    const statics = fn(mod.functions, 'fromList', 'Pipeline')!;
    expect(statics.modifiers).toContain('static');
    expect(statics.typeParameters).toBe('T extends { id: string }');

    const getter = fn(mod.functions, 'size', 'Pipeline')!;
    expect(getter.modifiers).toContain('get');
    expect(getter.returnType).toBe('number');
  });

  it('reads an arrow function with generic parameters and a default export', () => {
    const arrow = fn(mod.functions, 'createPipeline')!;
    expect(arrow.typeParameters).toBe('T extends { id: string }');
    expect(arrow.returnType).toBe('Pipeline<T>');

    const bootstrap = fn(mod.functions, 'bootstrap')!;
    expect(bootstrap.async).toBe(true);
    expect(bootstrap.exported).toBe(true);
    expect(bootstrap.returnType).toBe('Promise<void>');
    expect(bootstrap.params[0].name).toBe('options');
    expect(bootstrap.params[0].optional).toBe(true);
  });

  it('keeps type aliases, interfaces and their members', () => {
    const result = mod.types.find((type) => type.name === 'Result')!;
    expect(result.aliasBody).toContain('ok: true');
    const cache = mod.types.find((type) => type.name === 'Cache')!;
    expect(cache.kind).toBe('interface');
    expect(cache.typeParameters).toBe('T');
    expect(cache.members.map((member) => member.name)).toEqual(expect.arrayContaining(['capacity', 'getOrLoad()']));
  });
});

const URL_SOURCE = `// A comment that mentions https://example.com/docs and { braces }
export function endpoint(base: string): string {
  // The URL below is data, not a comment.
  const url = 'https://api.example.com/v1/items?limit=10';
  const template = \`/orders/\${base}/items\`;
  /* a block comment with } and {
     that spans lines */
  if (!base) {
    throw new TypeError("base must not be empty — see https://example.com");
  }
  return url + template;
}`;

describe('ANA-001 comments, strings and multi-line declarations', () => {
  it('does not treat a URL inside a string as a comment (REG-12)', () => {
    const mod = parseSource('endpoint.ts', URL_SOURCE);
    const endpoint = fn(mod.functions, 'endpoint')!;
    expect(endpoint).toBeTruthy();
    expect(endpoint.body.some((statement) => statement.text.includes('https://api.example.com'))).toBe(true);
    expect(endpoint.guards[0].condition).toBe('!base');
    expect(endpoint.errors[0].message).toContain('https://example.com');
  });

  it('ignores braces inside block comments and template literals', () => {
    const mod = parseSource('endpoint.ts', URL_SOURCE);
    expect(mod.diagnostics.filter((diagnostic) => diagnostic.code === 'unbalanced-braces')).toHaveLength(0);
    expect(mod.functions).toHaveLength(1);
    expect(mod.functions[0].endLine).toBeGreaterThan(mod.functions[0].startLine);
  });

  it('reads a signature that spans several lines', () => {
    const source = `export async function transfer(
  from: Account,
  to: Account,
  amount: number,
  options?: { memo?: string; retries?: number } = {},
): Promise<Result<string, Error>> {
  if (amount <= 0) {
    throw new RangeError('amount must be positive');
  }
  return from.debit(to, amount, options);
}`;
    const mod = parseSource('transfer.ts', source);
    const transfer = fn(mod.functions, 'transfer')!;
    expect(transfer.params.map((param) => param.name)).toEqual(['from', 'to', 'amount', 'options']);
    expect(transfer.params[3].type).toBe('{ memo?: string; retries?: number }');
    expect(transfer.returnType).toBe('Promise<Result<string, Error>>');
  });
});

const OBJECT_LITERAL = `const cache = {
  hits: 0,
  async load(key: string): Promise<string | null> {
    if (!key) {
      throw new TypeError('key is required');
    }
    return null;
  },
  clear: (): void => undefined,
};

export const handler = async (event: { id?: string }): Promise<void> => {
  await cache.load(event.id ?? '');
};`;

describe('ANA-001 object literal methods', () => {
  it('reads methods and arrow properties of an object literal', () => {
    const mod = parseSource('cache.ts', OBJECT_LITERAL);
    const load = fn(mod.functions, 'load', 'cache')!;
    expect(load.async).toBe(true);
    expect(load.params[0].type).toBe('string');
    expect(load.returnType).toBe('Promise<string | null>');
    expect(load.errors[0].error).toBe('TypeError');

    const clear = fn(mod.functions, 'clear', 'cache')!;
    expect(clear.returnType).toBe('void');

    const handler = fn(mod.functions, 'handler')!;
    expect(handler.async).toBe(true);
    expect(handler.params[0].type).toBe('{ id?: string }');
  });
});

const PYTHON_MODULE = `from __future__ import annotations

import asyncio
from typing import Optional, Callable

DEFAULT_TIMEOUT = 30


class Repository:
    """Async repository with typed collections."""

    def __init__(self, store, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.store = store
        self.timeout = timeout

    @staticmethod
    def normalise(value: str) -> str:
        return value.strip().lower()

    @classmethod
    async def connect(cls, dsn: str, **kwargs) -> "Repository":
        if not dsn:
            raise ValueError("dsn is required")
        return cls(dsn)

    async def fetch(
        self,
        key: str,
        fallback: Optional[dict[str, list[int]]] = None,
    ) -> dict[str, list[int]]:
        if not key:
            raise KeyError("key is required")
        return fallback or {}

    def names(self) -> list[str]:
        return [row["name"] for row in self.store.rows()]


def transform(items: list[int], fn: Callable[[int], str]) -> dict[str, int]:
    return {fn(item): item for item in items}
`;

describe('ANA-001 Python declarations', () => {
  const mod = parseSource('repository.py', PYTHON_MODULE);

  it('reads nested generics, Optional and keyword-only defaults', () => {
    const fetch = fn(mod.functions, 'fetch', 'Repository')!;
    expect(fetch.params.map((param) => param.name)).toEqual(['key', 'fallback']);
    expect(fetch.params[1].type).toBe('Optional[dict[str, list[int]]]');
    expect(fetch.params[1].optional).toBe(true);
    expect(fetch.returnType).toBe('dict[str, list[int]]');
    expect(fetch.errors.map((error) => error.error)).toContain('KeyError');
  });

  it('reads async methods that span several lines', () => {
    const fetch = fn(mod.functions, 'fetch', 'Repository')!;
    expect(fetch.async).toBe(true);
    const connect = fn(mod.functions, 'connect', 'Repository')!;
    expect(connect.async).toBe(true);
    expect(connect.params.map((param) => param.name)).toEqual(['dsn', 'kwargs']);
  });

  it('keeps decorator-based call shapes', () => {
    const statics = fn(mod.functions, 'normalise', 'Repository')!;
    expect(statics.modifiers).toContain('static');
    expect(statics.modifiers).toContain('decorator:staticmethod');
    const classmethod = fn(mod.functions, 'connect', 'Repository')!;
    expect(classmethod.modifiers).toContain('classmethod');
    expect(classmethod.className).toBe('Repository');
  });

  it('reads a Callable parameter and module constants', () => {
    const transform = fn(mod.functions, 'transform')!;
    expect(transform.params[1].type).toBe('Callable[[int], str]');
    expect(transform.returnType).toBe('dict[str, int]');
    expect(mod.globals.map((global) => global.name)).toContain('DEFAULT_TIMEOUT');
  });
});

const JAVA_SERVICE = `package com.hd2lab.orders;

import java.util.List;
import java.util.Map;
import java.util.Optional;

public class OrderService<T extends Order> {

    private final Map<String, List<T>> byCustomer;
    private static final int MAX_BATCH = 100;

    public OrderService(Map<String, List<T>> byCustomer) {
        this.byCustomer = byCustomer;
    }

    public static <R> List<R> mapAll(List<T> items, java.util.function.Function<T, R> mapper) {
        return items.stream().map(mapper).toList();
    }

    public Optional<List<T>> findBatch(String customerId, int limit)
            throws IllegalArgumentException, IllegalStateException {
        if (customerId == null) {
            throw new IllegalArgumentException("customerId is required");
        }
        if (limit > MAX_BATCH) {
            throw new IllegalStateException("batch too large");
        }
        return Optional.ofNullable(byCustomer.get(customerId));
    }

    public void clear() {
        byCustomer.clear();
    }
}`;

describe('ANA-001 Java declarations', () => {
  const mod = parseSource('OrderService.java', JAVA_SERVICE);

  it('reads nested generics in fields, params and returns', () => {
    const batch = fn(mod.functions, 'findBatch', 'OrderService')!;
    expect(batch.returnType).toBe('Optional<List<T>>');
    expect(batch.params[0].type).toBe('String');
    expect(batch.params[1].type).toBe('int');
    expect(batch.modifiers).toEqual(expect.arrayContaining(['throws IllegalArgumentException, IllegalStateException']));
  });

  it('reads a generic method and its type parameters', () => {
    const mapAll = fn(mod.functions, 'mapAll', 'OrderService')!;
    expect(mapAll.typeParameters).toBe('R');
    expect(mapAll.returnType).toBe('List<R>');
    expect(mapAll.params[1].type).toBe('java.util.function.Function<T, R>');
    expect(mapAll.modifiers).toContain('static');
  });

  it('keeps the constructor without inventing a return type', () => {
    const ctor = fn(mod.functions, 'OrderService', 'OrderService')!;
    expect(ctor.returnType).toBeUndefined();
    expect(ctor.params[0].type).toBe('Map<String, List<T>>');
  });

  it('reads a multi-line throws clause and guard paths', () => {
    const batch = fn(mod.functions, 'findBatch', 'OrderService')!;
    expect(batch.guards).toHaveLength(2);
    expect(batch.guards.map((guard) => guard.action)).toEqual(['throw', 'throw']);
  });
});

const GO_STORE = `package store

import (
	"context"
	"errors"
	"fmt"

	"example.com/telemetry"
)

type Entry[T any] struct {
	Key   string
	Value T
}

type Reader[T any] interface {
	Get(ctx context.Context, key string) (T, error)
}

type Service[T any] struct {
	entries map[string]Entry[T]
	client  *telemetry.Client
}

func NewService[T any](entries map[string]Entry[T]) *Service[T] {
	return &Service[T]{entries: entries}
}

func (s *Service[T]) Get(ctx context.Context, key string) (Entry[T], error) {
	if key == "" {
		return Entry[T]{}, errors.New("key is required")
	}
	entry, ok := s.entries[key]
	if !ok {
		return Entry[T]{}, fmt.Errorf("entry %q not found", key)
	}
	return entry, nil
}

func Map[T any, U any](items []T, fn func(T) U) []U {
	out := make([]U, 0, len(items))
	for _, item := range items {
		out = append(out, fn(item))
	}
	return out
}

func split(a, b string) (first, second string) {
	return a, b
}`;

describe('ANA-001 Go declarations', () => {
  const mod = parseSource('service.go', GO_STORE);

  it('reads generic receivers, parameters and return tuples', () => {
    const get = fn(mod.functions, 'Get', 'Service')!;
    expect(get.isMethod).toBe(true);
    expect(get.returnType).toBe('(Entry[T], error)');
    expect(get.params.map((param) => param.name)).toEqual(['ctx', 'key']);
    expect(get.params[0].type).toBe('context.Context');
    expect(get.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('reads a generic function with a function-type parameter', () => {
    const map = fn(mod.functions, 'Map')!;
    expect(map.typeParameters).toBe('T any, U any');
    expect(map.params[1].type).toBe('func(T) U');
    expect(map.returnType).toBe('[]U');
    expect(map.body.some((statement) => statement.kind === 'for')).toBe(true);
  });

  it('groups several names that share a type and keeps named results', () => {
    const split = fn(mod.functions, 'split')!;
    expect(split.params.map((param) => `${param.name}:${param.type}`)).toEqual(['a:string', 'b:string']);
    expect(split.returnType).toBe('(first, second string)');
  });

  it('reads generic struct and interface declarations', () => {
    expect(mod.types.map((type) => `${type.kind}:${type.name}`)).toEqual(
      expect.arrayContaining(['struct:Entry', 'interface:Reader', 'struct:Service']),
    );
    const reader = mod.types.find((type) => type.name === 'Reader')!;
    expect(reader.typeParameters).toBe('T any');
    expect(reader.methods).toContain('Get()');
  });
});

describe('ANA-001 partial support is reported, never silent', () => {
  it('reports an unclosed block instead of dropping the file', () => {
    const mod = parseSource('broken.ts', `export function ok(value: number): number {\n  return value;\n}\n\nexport function broken(x: number) {\n  if (x) {\n    return 1;\n`);
    expect(mod.functions.map((item) => item.name)).toEqual(expect.arrayContaining(['ok', 'broken']));
    expect(mod.diagnostics.some((diagnostic) => diagnostic.code === 'unbalanced-braces')).toBe(true);
    expect(mod.notes.some((note) => note.includes('Braces do not balance'))).toBe(true);
  });

  it('keeps a function whose parameter list it cannot fully read', () => {
    const mod = parseSource('weird.ts', `export function weird<T extends Map<string, Array<number>>>(value: T): T {\n  return value;\n}`);
    const weird = fn(mod.functions, 'weird')!;
    expect(weird).toBeTruthy();
    expect(weird.params[0].name).toBe('value');
    expect(weird.params[0].type).toBe('T');
  });

  it('notes an unrecognised language and still extracts structure', () => {
    const mod = parseSource('script.zzz', 'def run(x):\n    return x\n');
    expect(mod.language).toBe('python');
    const unknown = parseSource('data.zzz', 'function run(x) { return x; }');
    expect(unknown.language).toBe('javascript');
    expect(languageLabel('unknown')).toBe('Unknown');
    expect(detectLanguage('a.ts', '')).toBe('typescript');
  });
});
