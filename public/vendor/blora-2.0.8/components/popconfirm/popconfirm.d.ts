/**
 * Popconfirm: confirm before action.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_POPCONFIRM_TAG = "blora-popconfirm";
export interface PopconfirmController {
    destroy(): void;
}
export declare function createPopconfirmController(root: HTMLElement): PopconfirmController;
/** Confirmation popover CE with generated trigger, question and actions. */
export declare class BloraPopconfirm extends BloraElement {
    private controller;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraPopconfirm(registry?: CustomElementRegistry): void;
//# sourceMappingURL=popconfirm.d.ts.map