/**
 * Runtime icon registry for the opt-in full Lucide table.
 *
 * Kept free of the curated `icons.data.ts` import so the `icons-full` module
 * does not drag the curated set into its bundle.
 */
import type { BloraIconNode } from "./icons.data.js";
/** Merge additional icon data (e.g. the full Lucide table) into the factory. */
export declare function registerBloraIcons(data: Record<string, BloraIconNode[]>): void;
export declare function lookupExtraIcon(name: string): BloraIconNode[] | undefined;
export declare function hasExtraIcon(name: string): boolean;
//# sourceMappingURL=icons-registry.d.ts.map