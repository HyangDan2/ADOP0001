/** Built-in sample sources, used by the "Load sample" buttons and the test suite. */

export const TS_SAMPLE = `import { randomUUID } from 'crypto';
import { readFile } from 'node:fs/promises';
import { InvoiceRepository } from './invoice-repository';
import { sendReceipt } from './mailer';

export interface PaymentRequest {
  invoiceId: string;
  amount: number;
  currency?: string;
  retry?: boolean;
}

export type PaymentResult = {
  id: string;
  status: 'settled' | 'declined' | 'pending';
};

const MAX_AMOUNT = 50000;
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'KRW'];

export class PaymentService {
  private readonly repository: InvoiceRepository;

  constructor(repository: InvoiceRepository) {
    this.repository = repository;
  }

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    if (!request.invoiceId) {
      throw new Error('invoiceId is required');
    }
    if (request.amount <= 0) {
      throw new Error('amount must be positive');
    }
    if (request.amount > MAX_AMOUNT) {
      throw new Error('amount exceeds the per-transaction limit');
    }
    const currency = request.currency ?? 'USD';
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return { id: randomUUID(), status: 'declined' };
    }

    const invoice = await this.repository.find(request.invoiceId);
    if (!invoice) {
      throw new Error('invoice not found');
    }
    if (invoice.settled) {
      return { id: invoice.id, status: 'settled' };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const gatewayResult = await this.callGateway(request.amount, currency);
        if (gatewayResult === 'declined') {
          return { id: invoice.id, status: 'declined' };
        }
        await this.repository.markSettled(invoice.id);
        await sendReceipt(invoice.id, request.amount);
        return { id: invoice.id, status: 'settled' };
      } catch (error) {
        if (attempt === 2) {
          throw new Error('gateway unavailable after retries');
        }
      }
    }
    return { id: invoice.id, status: 'pending' };
  }

  private async callGateway(amount: number, currency: string): Promise<string> {
    const policy = await readFile('./config/gateway.json', 'utf8');
    if (!policy) {
      throw new Error('gateway policy missing');
    }
    return amount > 1000 ? 'declined' : 'approved';
  }
}

export async function reconcileBatch(ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  let settled = 0;
  for (const id of ids) {
    if (!id) {
      continue;
    }
    settled += 1;
  }
  return settled;
}
`;

export const PY_SAMPLE = `import hashlib
from dataclasses import dataclass
from typing import Optional

MAX_RETRIES = 3
ALLOWED_ROLES = ["admin", "editor", "viewer"]


@dataclass
class Account:
    email: str
    role: str
    active: bool = True


class AccountService:
    def __init__(self, store, notifier):
        self.store = store
        self.notifier = notifier

    def register(self, email: str, role: str = "viewer") -> Account:
        if not email or "@" not in email:
            raise ValueError("email is invalid")
        if role not in ALLOWED_ROLES:
            raise ValueError("role is not allowed")
        existing = self.store.find_by_email(email)
        if existing:
            return existing
        account = Account(email=email, role=role)
        self.store.save(account)
        self.notifier.send(email, "welcome")
        return account

    def deactivate(self, email: str) -> bool:
        account = self.store.find_by_email(email)
        if account is None:
            raise LookupError("account not found")
        if not account.active:
            return False
        account.active = False
        self.store.save(account)
        return True


def checksum(payload: bytes) -> str:
    if len(payload) == 0:
        return ""
    digest = hashlib.sha256(payload).hexdigest()
    return digest
`;

export const JAVA_SAMPLE = `package com.hd2lab.billing;

import java.util.List;
import java.util.Optional;

public class InvoiceService {

    private static final int MAX_LINES = 200;
    private final InvoiceRepository repository;

    public InvoiceService(InvoiceRepository repository) {
        this.repository = repository;
    }

    public Invoice create(String customerId, List<LineItem> lines) {
        if (customerId == null || customerId.isBlank()) {
            throw new IllegalArgumentException("customerId is required");
        }
        if (lines == null || lines.isEmpty()) {
            throw new IllegalArgumentException("at least one line is required");
        }
        if (lines.size() > MAX_LINES) {
            throw new IllegalArgumentException("too many lines");
        }
        double total = 0;
        for (LineItem line : lines) {
            if (line.amount() < 0) {
                throw new IllegalStateException("negative line amount");
            }
            total += line.amount();
        }
        Invoice invoice = new Invoice(customerId, lines, total);
        repository.save(invoice);
        return invoice;
    }

    public Optional<Invoice> find(String id) {
        if (id == null) {
            return Optional.empty();
        }
        return repository.findById(id);
    }
}
`;

export const GO_SAMPLE = `package billing

import (
	"errors"
	"fmt"
	"strings"
)

const maxAmount = 50000

type Charge struct {
	InvoiceID string
	Amount    int
	Currency  string
}

type Gateway interface {
	Authorize(amount int, currency string) (bool, error)
}

type Service struct {
	gateway Gateway
	store   Store
}

func NewService(g Gateway, s Store) *Service {
	return &Service{gateway: g, store: s}
}

func (s *Service) Charge(c Charge) (string, error) {
	if strings.TrimSpace(c.InvoiceID) == "" {
		return "", errors.New("invoice id is required")
	}
	if c.Amount <= 0 {
		return "", fmt.Errorf("amount must be positive: %d", c.Amount)
	}
	if c.Amount > maxAmount {
		return "", errors.New("amount exceeds limit")
	}
	ok, err := s.gateway.Authorize(c.Amount, c.Currency)
	if err != nil {
		return "", err
	}
	if !ok {
		return "declined", nil
	}
	if err := s.store.MarkSettled(c.InvoiceID); err != nil {
		return "", err
	}
	return "settled", nil
}
`;

export const TS_PIPELINE_SAMPLE = `import { createHash } from 'node:crypto';
import type { CacheStore } from './cache-store';

export type Outcome<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface Envelope<T> {
  readonly id: string;
  payload: T;
  attempts?: number;
}

const MAX_ATTEMPTS = 3;

/**
 * Runs every envelope through \`transform\`, retrying transient failures and
 * keeping the output order. A cache hit short-circuits the transform.
 */
export class ResultPipeline<T, U> {
  private readonly cache: CacheStore<string, U>;

  constructor(cache: CacheStore<string, U>, private readonly keyOf: (item: T) => string) {
    this.cache = cache;
  }

  async run(items: Envelope<T>[], transform: (item: T) => Promise<U>): Promise<Outcome<U[], Error>> {
    if (items.length === 0) {
      return { ok: true, value: [] };
    }
    const output: U[] = [];
    for (const envelope of items) {
      const key = this.keyOf(envelope.payload);
      if (!key) {
        throw new TypeError('keyOf returned an empty key');
      }
      const cached = await this.cache.get(key);
      if (cached !== undefined) {
        output.push(cached);
        continue;
      }
      const value = await this.attempt(envelope, transform);
      await this.cache.set(key, value);
      output.push(value);
    }
    return { ok: true, value: output };
  }

  private async attempt(envelope: Envelope<T>, transform: (item: T) => Promise<U>): Promise<U> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await transform(envelope.payload);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('transform failed');
  }

  fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }
}

export const groupByKey = <T, K extends string>(items: T[], keyOf: (item: T) => K): Record<K, T[]> =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    (acc[key] ??= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
`;

export const JS_SAMPLE = `import { EventEmitter } from 'node:events';

const DEFAULTS = { concurrency: 4, retryDelayMs: 25 };

/**
 * A tiny in-process job queue: bounded concurrency, one retry round and an event
 * for every state change, so a failing job is never silent.
 */
export class JobQueue extends EventEmitter {
  constructor(handler, options = {}) {
    super();
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    this.handler = handler;
    this.options = { ...DEFAULTS, ...options };
    this.pending = [];
    this.active = 0;
  }

  add(job) {
    if (!job || typeof job.id !== 'string') {
      throw new TypeError('job.id is required');
    }
    this.pending.push({ attempts: 0, ...job });
    this.emit('queued', job.id);
    this.drain();
    return this;
  }

  async drain() {
    while (this.active < this.options.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.active += 1;
      try {
        const result = await this.handler(job.payload);
        this.emit('completed', job.id, result);
      } catch (error) {
        if (job.attempts >= 1) {
          this.emit('failed', job.id, error);
        } else {
          this.pending.push({ ...job, attempts: job.attempts + 1 });
          this.emit('retrying', job.id, error);
        }
      } finally {
        this.active -= 1;
      }
    }
  }

  get size() {
    return this.pending.length;
  }
}

export const createQueue = (handler, options) => new JobQueue(handler, options);
`;

export const PY_ASYNC_SAMPLE = `from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Optional

DEFAULT_TIMEOUT = 15


@dataclass
class Account:
    email: str
    roles: list[str] = field(default_factory=list)

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles


class AsyncRepository:
    """Async account store that keeps a bounded in-memory index."""

    def __init__(self, client, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.client = client
        self.timeout = timeout
        self.index: dict[str, list[int]] = {}

    @staticmethod
    def normalise(email: str) -> str:
        return email.strip().lower()

    @classmethod
    async def connect(cls, dsn: str, **options) -> "AsyncRepository":
        if not dsn:
            raise ValueError("dsn is required")
        return cls(dsn, **options)

    async def fetch(self, email: str) -> Optional[Account]:
        key = self.normalise(email)
        if not key:
            raise KeyError("email is required")
        rows = await self.client.query(key)
        if not rows:
            return None
        return Account(email=key, roles=list(rows[0].get("roles", [])))

    async def fetch_many(self, emails: list[str], limit: int = 100) -> dict[str, Account]:
        if len(emails) > limit:
            raise ValueError("too many emails")
        results = await asyncio.gather(*(self.fetch(email) for email in emails))
        return {email: account for email, account in zip(emails, results) if account is not None}
`;

export const SAMPLE_BY_EXT: { label: string; fileName: string; code: string }[] = [
  { label: 'TypeScript · PaymentService', fileName: 'payment-service.ts', code: TS_SAMPLE },
  { label: 'TypeScript · ResultPipeline', fileName: 'result-pipeline.ts', code: TS_PIPELINE_SAMPLE },
  { label: 'JavaScript · JobQueue', fileName: 'job-queue.js', code: JS_SAMPLE },
  { label: 'Python · AccountService', fileName: 'account_service.py', code: PY_SAMPLE },
  { label: 'Python · AsyncRepository', fileName: 'async_repository.py', code: PY_ASYNC_SAMPLE },
  { label: 'Java · InvoiceService', fileName: 'InvoiceService.java', code: JAVA_SAMPLE },
  { label: 'Go · billing service', fileName: 'billing_service.go', code: GO_SAMPLE },
];
