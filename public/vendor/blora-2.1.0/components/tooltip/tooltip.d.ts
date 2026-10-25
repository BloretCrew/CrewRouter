/**
 * Tooltip: reposition bubble (v1 fitFloatingInline simplified).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TOOLTIP_TAG = "blora-tooltip";
export interface TooltipController {
    destroy(): void;
}
export declare function createTooltipController(root: HTMLElement): TooltipController;
/** Tooltip CE that owns the trigger/bubble relationship. */
export declare class BloraTooltip extends BloraElement {
    private controller;
    private triggerNodes;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTooltip(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tooltip.d.ts.map