/**
 * Fixtures for the Phase 1 regression matrix (HAR-001..003, TAK-001).
 *
 * Kept as string constants so the parser sees exactly the bytes a user would
 * paste, and so `tsc` never tries to type-check the fixture bodies.
 */

/** HAR-001: the seven functions named in the work order, plus one unsupported shape. */
export const HARUHI_RELIABILITY_TS = `export function isPositive(x: number): boolean {
  return x > 0;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new RangeError('division by zero');
  }
  return a / b;
}

export async function fetchData(url: string): Promise<string> {
  if (!url) {
    throw new TypeError('url is required');
  }
  return 'payload';
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  static subtract(a: number, b: number): number {
    return a - b;
  }
}

export function voidFunction(): void {
  console.log('done');
}

export function throwsOnInvalid(): void {
  throw new TypeError('invalid');
}

export function run(callback: Function): number {
  return callback(1);
}
`;

/** HAR-002: a Python module with a class method, a None-returning method and a guard. */
export const HARUHI_RELIABILITY_PY = `class AccountService:
    def __init__(self):
        self.seen = []

    def register(self, email: str, role: str = "viewer") -> str:
        if not email:
            raise ValueError("email is invalid")
        self.seen.append(email)
        return email

    def ping(self) -> None:
        return None


def clamp(value: float, low: float) -> float:
    if value < low:
        return low
    return value


def require_role(role: str) -> str:
    if not role:
        raise ValueError("role is required")
    return role
`;

/** HAR-002: a Java class whose constructor needs a dependency. */
export const HARUHI_RELIABILITY_JAVA = `package com.hd2lab.billing;

public class LedgerService {

    private final LedgerRepository repository;

    public LedgerService(LedgerRepository repository) {
        this.repository = repository;
    }

    public int total(int amount) {
        if (amount < 0) {
            throw new IllegalArgumentException("amount must be positive");
        }
        return amount;
    }

    public void flush() {
        this.repository.save();
    }

    public static int zero() {
        return 0;
    }

    public static int negate(int amount) {
        if (amount < 0) {
            throw new IllegalArgumentException("amount must be positive");
        }
        return -amount;
    }
}
`;

/** HAR-002: Go functions with (string, error), a plain return and a void function. */
export const HARUHI_RELIABILITY_GO = `package ledger

import (
	"errors"
)

func Settle(id string) (string, error) {
	if id == "" {
		return "", errors.New("id is required")
	}
	return id, nil
}

func Count(ids []string) int {
	return len(ids)
}

func Reset() {
}
`;

/** TAK-001: an optional parameter before a required one, and a dataclass with the same shape. */
export const TAKANE_ORDER_SPEC = `# Specification — order-service

## 1. Overview

- **Language**: TypeScript

## 2. Contracts

| Contract | Returns | Visibility |
| --- | --- | --- |
| \`create(label: string = 'default', count: number, note?: string)\` | string | public |
| \`ship(order: Order, when: string?)\` | boolean | public |
| \`quote(request: QuoteRequest)\` | Quote | public |

## 3. Data model

### interface Order

- id: string
- note?: string
- total: number

## 4. Behaviour

| Function | When | Then | Message |
| --- | --- | --- | --- |
| create | \`!count\` | throw | count is required |
| ship | \`!order.id\` | throw | order id is required |

## 5. Errors

| Function | Error | Message |
| --- | --- | --- |
| create | ValueError | count is required |
`;

/** TAK-001: a quoted message that must be escaped in every target language. */
export const TAKANE_ESCAPE_SPEC = `# Specification — escape-service

## 2. Contracts

| Contract | Returns |
| --- | --- |
| \`label(name: string)\` | string |

## 4. Behaviour

| Function | When | Then | Message |
| --- | --- | --- | --- |
| label | \`!name\` | throw | bad "name" and \\ slash |
`;
