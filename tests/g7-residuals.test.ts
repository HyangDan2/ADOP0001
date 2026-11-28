import { describe, expect, it } from 'vitest';
import { fingerprintPayload } from '../src/engine/hybrid/preflight';
import type { ChatMessage } from '../src/engine/hybrid/contracts';

/**
 * G6-RES-005 — approval identity hash collision resistance review.
 *
 * The identity is SHA-256 over a domain-separated canonical array
 * (`adop0001.hybrid.payload.v1`, endpoint, model, messages), so the review is:
 * 64 hex digits, deterministic, and sensitive to every identity input including
 * a one-character message change. Collision probability is the generic
 * 2^-128 birthday bound; no truncation is applied.
 */
describe('G6-RES-005 approval identity hashing', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'draw the diagram' }];

  it('is a full SHA-256 digest and deterministic', async () => {
    const first = await fingerprintPayload('https://api.example.com/v1/chat', 'model-a', messages);
    const second = await fingerprintPayload('https://api.example.com/v1/chat', 'model-a', messages);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes for endpoint, model and a one-character message edit', async () => {
    const base = await fingerprintPayload('https://api.example.com/v1/chat', 'model-a', messages);
    expect(await fingerprintPayload('https://api.example.com/v2/chat', 'model-a', messages)).not.toBe(base);
    expect(await fingerprintPayload('https://api.example.com/v1/chat', 'model-b', messages)).not.toBe(base);
    expect(
      await fingerprintPayload('https://api.example.com/v1/chat', 'model-a', [{ role: 'user', content: 'draw the diagram!' }]),
    ).not.toBe(base);
  });

  it('keeps message order significant', async () => {
    const two: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const reversed = [...two].reverse();
    expect(await fingerprintPayload('https://api.example.com/v1/chat', 'm', two)).not.toBe(
      await fingerprintPayload('https://api.example.com/v1/chat', 'm', reversed),
    );
  });
});
