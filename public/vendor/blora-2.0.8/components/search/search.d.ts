/**
 * Blora Design 2.0 - Search controller
 * Wires up the clear button visibility and click-to-clear behavior.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SEARCH_TAG = "blora-search";
export interface SearchController {
    destroy(): void;
}
export declare function createSearchController(root: HTMLElement): SearchController;
/** Composite CE that owns the search icon, native field and clear affordance. */
export declare class BloraSearch extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private internals;
    /** Submitted under `name` via ElementInternals; inner input stays unnamed. */
    private syncFormValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSearch(registry?: CustomElementRegistry): void;
//# sourceMappingURL=search.d.ts.map