/**
 * Q05 E2E helper — two-tab harness (REG-G1-17/22/25, INV-21/22).
 *
 * Two pages in one browser context approximate two tabs. The harness only owns
 * lifecycle and outcome collection; it never decides who won a race.
 */
export interface PageLike {
  close?(): Promise<void>;
}

export interface ContextLike<TPage extends PageLike> {
  newPage(): Promise<TPage>;
}

export interface TabOutcome<T> {
  label: string;
  status: 'fulfilled' | 'rejected';
  value?: T;
  error?: string;
}

export interface TwoTabHarness<TPage extends PageLike> {
  pages(): ReadonlyMap<string, TPage>;
  open(label: string): Promise<TPage>;
  run<T>(
    labels: readonly [string, string],
    routine: (page: TPage, label: string) => Promise<T>,
  ): Promise<[TabOutcome<T>, TabOutcome<T>]>;
  closeAll(): Promise<void>;
}

export function createTwoTabHarness<TPage extends PageLike>(context: ContextLike<TPage>): TwoTabHarness<TPage> {
  const opened = new Map<string, TPage>();

  const require = (label: string): TPage => {
    const page = opened.get(label);
    if (!page) throw new Error(`Two-tab harness has no open page labelled "${label}"`);
    return page;
  };

  const toOutcome = <T>(label: string, result: PromiseSettledResult<T>): TabOutcome<T> =>
    result.status === 'fulfilled'
      ? { label, status: 'fulfilled', value: result.value }
      : { label, status: 'rejected', error: result.reason instanceof Error ? result.reason.message : String(result.reason) };

  return {
    pages: () => new Map(opened),

    async open(label) {
      if (opened.has(label)) throw new Error(`Two-tab harness already has a page labelled "${label}"`);
      const page = await context.newPage();
      opened.set(label, page);
      return page;
    },

    async run(labels, routine) {
      const [first, second] = labels;
      const results = await Promise.allSettled([
        routine(require(first), first),
        routine(require(second), second),
      ]);
      return [toOutcome(first, results[0]), toOutcome(second, results[1])];
    },

    async closeAll() {
      const pages = [...opened.values()].reverse();
      opened.clear();
      for (const page of pages) {
        try {
          await page.close?.();
        } catch {
          // Cleanup must not mask the test outcome.
        }
      }
    },
  };
}
