/**
 * Blora Design 2.0 - Megamenu controller
 * Stays in core (product decision). Baseline: v1 initMegamenu.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_MEGAMENU_TAG = "blora-megamenu";
export interface MegamenuController {
    open(): void;
    close(): void;
    destroy(): void;
}
/** v1 initMegamenu parity: data-open, panel fit, Escape, exclusive open. */
export declare function createMegamenuController(root: HTMLElement): MegamenuController;
/** Megamenu CE that owns trigger, panel and section grid structure. */
export declare class BloraMegamenu extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraMegamenu(registry?: CustomElementRegistry): void;
//# sourceMappingURL=megamenu.d.ts.map