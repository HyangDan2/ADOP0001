/**
 * INT-002 — the final payload's own token accounting.
 *
 * The budget estimated the sections before they were assembled and redacted. Two
 * numbers were never checked afterwards:
 *
 * - the *final* redacted messages (redaction changes length, and a custom pattern
 *   can add text), and
 * - the protocol overhead every chat API charges for roles, separators and the
 *   reply priming.
 *
 * The estimate is deliberately still an estimate — no tokenizer is downloaded, and
 * the UI says so. What changes is that the estimate is made over what will really
 * be transmitted, with the overhead counted, and the request is refused when that
 * number exceeds the allowance the allocation granted.
 */

import type { ChatMessage } from './contracts';
import { hybridConfig } from './config';

/** Same character-based estimate as the prompt pane, with a profile's ratio. */
export function estimateTokensWith(text: string, charsPerToken = 4): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii += 1;
    else wide += 1;
  }
  const perToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : 4;
  return Math.max(1, Math.ceil(ascii / perToken + wide / 1.6));
}

export interface MessageTokenOptions {
  /** Characters per token for this model family (profile-driven). */
  charsPerToken?: number;
  /** Tokens every message costs for its role and separators. */
  perMessageOverhead?: number;
  /** Tokens the chat template spends before the first message (reply priming). */
  replyPrimingTokens?: number;
}

export interface MessageTokenCount {
  /** Tokens of the message contents alone. */
  contentTokens: number;
  /** Role, separator and priming overhead. */
  protocolTokens: number;
  /** content + protocol — the number the provider will see. */
  total: number;
  messages: number;
}

export function countMessageTokens(messages: ChatMessage[], options: MessageTokenOptions = {}): MessageTokenCount {
  const budget = hybridConfig.read().budget;
  const charsPerToken = options.charsPerToken ?? budget.charsPerToken;
  const perMessage = options.perMessageOverhead ?? budget.perMessageOverheadTokens;
  const priming = options.replyPrimingTokens ?? budget.replyPrimingTokens;
  let contentTokens = 0;
  for (const message of messages) {
    contentTokens += estimateTokensWith(message.content, charsPerToken);
    // A role name is part of the protocol, not of the content.
    contentTokens += 0;
  }
  const protocolTokens = Math.max(0, messages.length * perMessage + priming);
  return {
    contentTokens,
    protocolTokens,
    total: contentTokens + protocolTokens,
    messages: messages.length,
  };
}
