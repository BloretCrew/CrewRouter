/** Fill every `[data-icon]` host inside (and including) `root`. Idempotent. */
export declare function hydrateIcons(root?: ParentNode): void;
/**
 * Hydrate now and keep hydrating icons that are added later or whose
 * `data-icon` changes. Returns a cleanup function; calling it twice for the
 * same document reuses the first observer.
 */
export declare function observeIcons(doc?: Document): () => void;
//# sourceMappingURL=icon-hydration.d.ts.map