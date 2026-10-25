/**
 * Collapse / accordion controller.
 *
 * Open height = measured content (px), written to --blora-collapse-h.
 * Closed height = 0 via CSS. No hard-coded caps (400px etc.).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_COLLAPSE_TAG = "blora-collapse";
export interface CollapseController {
    destroy(): void;
}
export declare function createCollapseController(root: HTMLElement): CollapseController;
/** Composite CE. Child `<blora-collapse-item>` definitions become official disclosure markup. */
export declare class BloraCollapse extends BloraElement {
    private controller;
    private definitions;
    private readonly instanceId;
    protected render(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraCollapse(registry?: CustomElementRegistry): void;
//# sourceMappingURL=collapse.d.ts.map