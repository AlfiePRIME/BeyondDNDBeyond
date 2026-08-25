/**
 * A getBoundingClientRect() cache for hot pointer-event paths (e.g.
 * pointermove) where a synchronous layout read on every event would be
 * costly. Recomputes lazily on resize/scroll rather than on every access.
 */
export interface RectCache {
  current: DOMRect;
  destroy(): void;
}

export function createRectCache(el: Element): RectCache {
  const cache: RectCache = {
    current: el.getBoundingClientRect(),
    destroy() {
      observer.disconnect();
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    },
  };

  function refresh() {
    cache.current = el.getBoundingClientRect();
  }

  const observer = new ResizeObserver(refresh);
  observer.observe(el);
  // Capture phase so ancestor scroll containers (not just window) are caught.
  window.addEventListener("scroll", refresh, true);
  window.addEventListener("resize", refresh);

  return cache;
}
