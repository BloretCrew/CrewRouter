/**
 * Blora Design 2.0 - Range controller (dual-thumb)
 * Optional tooltip-on-drag via data-tooltip attribute (v1 default behavior).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_RANGE_TAG = "blora-range";
export interface RangeController {
    destroy(): void;
}
export declare function createRangeController(root: HTMLElement): RangeController;
/** Composite CE that owns the official dual-thumb light-DOM structure. */
export declare class BloraRange extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private internals;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get values(): [number, number];
    set values(value: [number, number]);
    /** Submitted as one comma-joined entry matching the `values` attribute format. */
    private syncFormValue;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraRange(registry?: CustomElementRegistry): void;
//# sourceMappingURL=range.d.ts.map