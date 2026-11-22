import { useEffect, useState } from 'react';

/**
 * UI-002 — matches a CSS media query in React state.
 *
 * The PC studio (workspace rail and prompt pane) is not rendered at all below
 * 1024px, so a phone never mounts the folder reader or the prompt editor. CSS
 * alone only hid them, which kept them in the accessibility tree, in the DOM and
 * in screenshot-based layout checks.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
