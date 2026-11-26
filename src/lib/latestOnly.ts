/**
 * INT-008 — last click wins.
 *
 * Reading a file from the workspace rail is asynchronous. If the operator clicks
 * file B while file A is still being read, A's payload must not arrive later and
 * replace B. The same applies to opening another folder while a read is running.
 *
 * The guard is a tiny token source: a caller takes a token before an await and
 * checks it after. A newer token (or `invalidate()`) makes the older work stale.
 * It is a separate module so the rule is testable without a browser.
 */
export interface LatestGuard {
  /** Starts a new operation and returns its token. */
  next(): number;
  /** True while the token is still the newest one. */
  current(token: number): boolean;
  /** Makes every outstanding token stale (folder change, unmount). */
  invalidate(): void;
}

export function createLatestGuard(): LatestGuard {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    current(token: number) {
      return token === latest;
    },
    invalidate() {
      latest += 1;
    },
  };
}
