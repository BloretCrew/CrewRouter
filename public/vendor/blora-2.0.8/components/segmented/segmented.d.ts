/**
 * Segmented control with sliding indicator (v1 initSegmented).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SEGMENTED_TAG = "blora-segmented";
export interface SegmentedController {
    destroy(): void;
}
export declare function createSegmentedController(root: HTMLElement): SegmentedController;
/** Composite CE. Child `<blora-segment>` definitions become official buttons. */
export declare class BloraSegmented extends BloraElement {
    private controller;
    private definitions;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSegmented(registry?: CustomElementRegistry): void;
//# sourceMappingURL=segmented.d.ts.map