/**
 * WO-12 — the Content-Security-Policy this app is published with.
 *
 * GitHub Pages cannot send response headers, so the policy travels in a `<meta>`
 * tag that the build injects into `dist/index.html` (never into the dev server,
 * which needs inline scripts for React Fast Refresh).
 *
 * The one interesting decision is `connect-src`.
 *
 * The gateway host is chosen by the user at run time (any OpenAI-compatible
 * endpoint), so a closed allow-list would make the app's own feature impossible:
 * a fixed `connect-src https://api.openai.com` would block every other provider,
 * and `connect-src 'self'` would block all of them. The policy therefore allows
 * `https:` — and the app narrows it in code, where it can be specific:
 *
 * - the endpoint must be `https` (plain `http` only for loopback, which the
 *   policy also allows so a local gateway works),
 * - the request goes to exactly the origin the user typed, once per approved
 *   payload,
 * - a redirect to another origin is refused before the `Authorization` header
 *   could be replayed,
 * - no telemetry, analytics or font host is contacted at all.
 *
 * What the policy still buys: no inline or third-party script may run, no
 * `http://` gateway (except loopback), no plugin/object/embed, no form
 * submission, no framing, no base-uri rewrite, and no `data:` document.
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React style attributes and the theme variables are inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The user-chosen gateway over https, plus a loopback gateway for local models.
  'connect-src https: http://localhost:* http://127.0.0.1:*',
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/**
 * Caveat documented in docs/PROMPT_SECURITY_POLICY.md: a meta-tag policy cannot
 * carry `frame-ancestors`, `report-uri` or `sandbox`. Those would need a header,
 * which GitHub Pages does not allow; the app does not frame itself or anything
 * else, and `frame-src 'none'` covers the other direction.
 */
export const CSP_META_HTTP_EQUIV = 'Content-Security-Policy';
