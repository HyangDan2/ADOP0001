import type {
  HybridProvider,
  HybridProviderRequest,
  HybridProviderResponse,
} from './contracts';
import { HybridResponseError } from './contracts';
import type { Transport, TransportRequest, TransportResponse } from './transport';

/**
 * Deterministic in-memory provider used by tests and by the prompt-preview
 * screen. It records the exact request it was given and returns queued text;
 * it has no network code at all.
 */
export class MockHybridProvider implements HybridProvider {
  readonly id = 'mock';
  readonly requests: HybridProviderRequest[] = [];
  private readonly responses: string[];

  constructor(responses: string[] = ['{}']) {
    this.responses = [...responses];
  }

  async complete(request: HybridProviderRequest): Promise<HybridProviderResponse> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    if (request.signal?.aborted) throw new HybridResponseError('aborted', 'The mock request was aborted.');
    const text = this.responses.shift();
    if (text === undefined) throw new HybridResponseError('provider', 'The mock has no queued response.');
    return { text, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async completeStream(
    request: HybridProviderRequest,
    onDelta: (chunk: string) => void,
  ): Promise<HybridProviderResponse> {
    const response = await this.complete(request);
    for (const chunk of response.text.match(/.{1,8}/gs) ?? []) onDelta(chunk);
    return response;
  }
}

/* ------------------------------------------------------------------ */
/* Transports for the network-free provider tests (WO-03)              */
/* ------------------------------------------------------------------ */

export interface MockTransportCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Convenience: the bearer value exactly as it was sent. */
  authorization: string | null;
  signal: AbortSignal;
}

export interface MockTransportReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** SSE frames delivered as the response body. */
  stream?: string[];
  /** Rejects the `send` call instead of replying (network / CORS / abort). */
  throw?: unknown;
  /** Aborts the request signal before replying, to exercise cancel paths. */
  abortBeforeReply?: boolean;
}

function streamFrom(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/**
 * A queue of canned replies. Every call is recorded so a test can assert what
 * would have been transmitted — URL, headers and body — without a network.
 */
export function createMockTransport(replies: MockTransportReply[]): {
  transport: Transport;
  calls: MockTransportCall[];
} {
  const calls: MockTransportCall[] = [];
  const queue = [...replies];

  const transport: Transport = {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const reply = queue.shift() ?? { status: 500, body: '{"error":{"message":"no queued reply"}}' };
      calls.push({
        url: request.url,
        headers: { ...request.headers },
        body: request.body,
        authorization: request.headers.authorization ?? null,
        signal: request.signal,
      });
      if (reply.abortBeforeReply) {
        // Simulates a cancel that arrives while the provider is still working.
        (request.signal as AbortSignal & { dispatchEvent?: (event: Event) => boolean }).dispatchEvent?.(new Event('abort'));
      }
      if (reply.throw !== undefined) throw reply.throw;
      const headers = reply.headers ?? { 'content-type': reply.stream ? 'text/event-stream' : 'application/json' };
      const status = reply.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        text: async () => reply.body ?? '',
        body: reply.stream ? streamFrom(reply.stream) : null,
      };
    },
  };

  return { transport, calls };
}

/** Frames a text answer the way an OpenAI-compatible stream would. */
export function sseFrames(answer: string, options: { usage?: { prompt_tokens?: number; completion_tokens?: number } } = {}): string[] {
  const chunks = answer.match(/[\s\S]{1,6}/g) ?? [];
  const frames = chunks.map(
    (chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`,
  );
  if (options.usage) frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: options.usage })}\n\n`);
  else frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
  frames.push('data: [DONE]\n\n');
  return frames;
}
