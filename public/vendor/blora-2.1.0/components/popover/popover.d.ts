/**
 * Popover toggle (v1 simplified, no portal required).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_POPOVER_TAG = "blora-popover";
export interface PopoverController {
    open(): void;
    close(): void;
    destroy(): void;
}
export declare function createPopoverController(root: HTMLElement, onOpenChange?: (open: boolean) => void): PopoverController;
/** Popover CE with generated trigger and dialog panel. */
export declare class BloraPopover extends BloraElement {
    private controller;
    private reflecting;
    private contentNodes;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraPopover(registry?: CustomElementRegistry): void;
//# sourceMappingURL=popover.d.ts.map