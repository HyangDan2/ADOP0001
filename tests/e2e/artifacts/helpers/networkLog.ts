/**
 * Q05 E2E helper — context-level request log (REG-G1-20, INV-24).
 *
 * `watch()` in the existing specs only records failures. REG-G1-20 needs every
 * request with its origin. This module depends on a structural observer
 * (`on('request')`) instead of importing Playwright, so it is unit-testable and
 * works for a page, a context, or both.
 */
export interface RequestLike {
  url(): string;
}

export type RequestListener = (request: RequestLike) => void;

export interface RequestObserver {
  on(event: 'request', listener: RequestListener): unknown;
  off?(event: 'request', listener: RequestListener): unknown;
}

export interface NetworkEntry {
  pageLabel: string;
  url: string;
  origin: string | null;
  scheme: string;
  external: boolean;
}

export interface NetworkLogOptions {
  /** Origins that belong to the app under test (e.g. http://127.0.0.1:4273). */
  allowedOrigins: readonly string[];
  pageLabel?: string;
}

export interface NetworkLog {
  entries(): readonly NetworkEntry[];
  external(): readonly NetworkEntry[];
  origins(): string[];
  total(): number;
  assertNoExternalRequests(): void;
  reset(): void;
  stop(): void;
}

/** Schemes that never leave the machine and carry no origin. */
const LOCAL_ONLY_SCHEMES = new Set(['data', 'blob', 'about']);

export function classifyRequest(
  rawUrl: string,
  allowedOrigins: readonly string[],
  pageLabel = 'page',
): NetworkEntry {
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { pageLabel, url: rawUrl, origin: null, scheme: 'invalid', external: true };
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (LOCAL_ONLY_SCHEMES.has(scheme)) {
    return { pageLabel, url: rawUrl, origin: null, scheme, external: false };
  }
  if (scheme === 'http' || scheme === 'https') {
    return {
      pageLabel,
      url: rawUrl,
      origin: parsed.origin,
      scheme,
      external: !allowedOrigins.includes(parsed.origin),
    };
  }
  return { pageLabel, url: rawUrl, origin: parsed.origin, scheme, external: true };
}

export function createNetworkLog(observer: RequestObserver, options: NetworkLogOptions): NetworkLog {
  const pageLabel = options.pageLabel ?? 'page';
  const collected: NetworkEntry[] = [];
  const listener: RequestListener = (request) => {
    collected.push(classifyRequest(request.url(), options.allowedOrigins, pageLabel));
  };
  observer.on('request', listener);

  let attached = true;
  const detach = () => {
    if (!attached) return;
    attached = false;
    observer.off?.('request', listener);
  };

  return {
    entries: () => [...collected],
    external: () => collected.filter((entry) => entry.external),
    origins: () => [...new Set(collected.map((entry) => entry.origin).filter((origin): origin is string => !!origin))].sort(),
    total: () => collected.length,
    assertNoExternalRequests: () => {
      const external = collected.filter((entry) => entry.external);
      if (external.length) {
        const sample = external
          .slice(0, 5)
          .map((entry) => `${entry.pageLabel} ${entry.url}`)
          .join(', ');
        throw new Error(`${external.length} external request(s) during local-only operation: ${sample}`);
      }
    },
    reset: () => {
      collected.length = 0;
    },
    stop: detach,
  };
}
