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

export const SAMPLE_BY_EXT: { label: string; fileName: string; code: string }[] = [
  { label: 'TypeScript · PaymentService', fileName: 'payment-service.ts', code: TS_SAMPLE },
  { label: 'Python · AccountService', fileName: 'account_service.py', code: PY_SAMPLE },
  { label: 'Java · InvoiceService', fileName: 'InvoiceService.java', code: JAVA_SAMPLE },
  { label: 'Go · billing service', fileName: 'billing_service.go', code: GO_SAMPLE },
];
