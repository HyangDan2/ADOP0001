/**
 * INT-001 / INT-006 — the one place the HTTP body is decided.
 *
 * Phase 5C.1 sealed the *messages* the user approved and then let the provider
 * build the body from the live settings: temperature, output limit, the streaming
 * flag and the usage option were decided again at send time. The approval proved
 * nothing about the parameters that actually shaped the answer.
 *
 * This module makes the body a value:
 *
 * - `chatBodySpecFor()` derives the body from the *effective* settings (the
 *   allocation's output budget, the capability profile's parameter spelling and
 *   feature set) — never from a model name branch;
 * - `serializeChatBody()` is the only serializer, used both for the snapshot
 *   digest and by the provider, so the bytes that were approved are the bytes that
 *   leave the tab;
 * - `bodyDigestMaterial()` is the canonical form the digest covers.
 *
 * A capability profile decides which parameters exist:
 *
 *   outputTokenParameter  `max_tokens` or `max_completion_tokens`
 *   temperature           some reasoning models reject it
 *   streamingUsage        `stream_options.include_usage`
 *   structuredOutput      `response_format`
 *   terminalPolicy        how a stream is allowed to end (INT-004)
 */
import type { ChatMessage } from './contracts';
import { canonicalJson } from './canonical';
import type { ProviderCapabilities } from './providerProfiles';

export type OutputTokenParameter = 'max_tokens' | 'max_completion_tokens';
export type TerminalPolicy = 'done' | 'finish' | 'finish-or-done';

export interface ProviderBodyPolicy {
  /** The parameter name the provider accepts for the answer allowance. */
  outputTokenParameter: OutputTokenParameter;
  /** False for models that reject `temperature` (reasoning families). */
  temperature: boolean;
  /** True when `stream_options.include_usage` is accepted. */
  streamingUsage: boolean;
  /** True when `response_format` may be sent. */
  structuredOutput: boolean;
  /** What completes a stream: `[DONE]`, a finish reason, or either. */
  terminalPolicy: TerminalPolicy;
}

export const NEUTRAL_BODY_POLICY: ProviderBodyPolicy = {
  outputTokenParameter: 'max_tokens',
  temperature: true,
  streamingUsage: true,
  structuredOutput: true,
  terminalPolicy: 'finish-or-done',
};

export interface ChatBodySpec {
  model: string;
  /** `null` means the parameter is omitted (the profile refuses it). */
  temperature: number | null;
  /** The effective answer allowance after capability and context clamping. */
  maxOutputTokens: number;
  stream: boolean;
  streamUsage: boolean;
  outputTokenParameter: OutputTokenParameter;
  responseFormat: 'json_object' | null;
  /** Capability identity, so a profile change is part of the digest. */
  providerId: string;
  terminalPolicy: TerminalPolicy;
}

export interface BodySpecInput {
  model: string;
  temperature: number;
  maxOutputTokens: number;
  streaming: boolean;
  capabilities: Pick<ProviderCapabilities, 'body' | 'streaming' | 'maxOutputTokens'>;
  providerId: string;
  /** The caller's explicit opt-in for a JSON-mode response format. */
  structuredOutput?: boolean;
}

/** Clamps the user's answer allowance to the model ceiling (INT-002). */
export function effectiveOutputTokens(requested: number, capabilities: Pick<ProviderCapabilities, 'maxOutputTokens'>): number {
  const requestedValue = Number.isFinite(requested) && requested > 0 ? requested : 1;
  const ceiling = Number.isFinite(capabilities.maxOutputTokens) ? capabilities.maxOutputTokens : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(requestedValue, ceiling));
}

export function chatBodySpecFor(input: BodySpecInput): ChatBodySpec {
  const body = input.capabilities.body ?? NEUTRAL_BODY_POLICY;
  const stream = Boolean(input.streaming && input.capabilities.streaming);
  return {
    model: input.model,
    temperature: body.temperature ? Math.min(2, Math.max(0, input.temperature)) : null,
    maxOutputTokens: effectiveOutputTokens(input.maxOutputTokens, input.capabilities),
    stream,
    streamUsage: stream && body.streamingUsage,
    outputTokenParameter: body.outputTokenParameter,
    responseFormat: input.structuredOutput && body.structuredOutput ? 'json_object' : null,
    providerId: input.providerId,
    terminalPolicy: body.terminalPolicy,
  };
}

/** The HTTP body, in a fixed key order, for exactly these messages. */
export function bodyObjectFor(spec: ChatBodySpec, messages: ChatMessage[]): Record<string, unknown> {
  const body: Record<string, unknown> = { model: spec.model };
  body.messages = messages.map((message) => ({ role: message.role, content: message.content }));
  if (spec.temperature !== null) body.temperature = spec.temperature;
  body[spec.outputTokenParameter] = spec.maxOutputTokens;
  body.stream = spec.stream;
  if (spec.stream && spec.streamUsage) body.stream_options = { include_usage: true };
  if (spec.responseFormat) body.response_format = { type: spec.responseFormat };
  return body;
}

/** The exact bytes the provider transmits (and the digest is computed over). */
export function serializeChatBody(spec: ChatBodySpec, messages: ChatMessage[]): string {
  return canonicalJson(bodyObjectFor(spec, messages));
}

/** Canonical material for the snapshot digest (no messages: those are digested separately). */
export function bodyDigestMaterial(spec: ChatBodySpec): string {
  return canonicalJson(['adop0001.hybrid.body.v1', spec]);
}

/** A body spec that reproduces the Phase 5C body for a provider with no profile. */
export function neutralBodySpec(params: {
  model: string;
  temperature: number;
  maxOutputTokens: number;
  streaming: boolean;
  providerId?: string;
}): ChatBodySpec {
  return {
    model: params.model,
    temperature: Math.min(2, Math.max(0, params.temperature)),
    maxOutputTokens: params.maxOutputTokens,
    stream: params.streaming,
    streamUsage: params.streaming,
    outputTokenParameter: 'max_tokens',
    responseFormat: null,
    providerId: params.providerId ?? 'unspecified',
    terminalPolicy: NEUTRAL_BODY_POLICY.terminalPolicy,
  };
}

/** True when two specs would produce the same request parameters. */
export function sameBodySpec(left: ChatBodySpec | null, right: ChatBodySpec | null): boolean {
  if (left === null || right === null) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}
