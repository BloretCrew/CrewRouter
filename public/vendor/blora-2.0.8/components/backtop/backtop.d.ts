/**
 * BackTop: show after scroll threshold; click scrolls to top (v1 initBackTop / backTop).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_BACKTOP_TAG = "blora-backtop";
export interface BackTopController {
    show(): void;
    hide(): void;
    destroy(): void;
}
export interface BackTopOptions {
    showAfter?: number;
    target?: HTMLElement | Window | null;
}
export declare function createBackTopController(btn: HTMLElement, options?: BackTopOptions): BackTopController;
/** Bind all [data-blora-backtop] / .blora-backtop in scope. */
export declare function initBackTop(root?: ParentNode): () => void;
/** Back-to-top CE backed by the existing scroll controller. */
export declare class BloraBacktop extends BloraElement {
    private controller;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    show(): void;
    hide(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraBacktop(registry?: CustomElementRegistry): void;
//# sourceMappingURL=backtop.d.ts.map