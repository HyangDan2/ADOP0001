import type {
  HybridProvider,
  HybridProviderRequest,
  HybridProviderResponse,
} from './contracts';
import { HybridResponseError } from './contracts';

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
