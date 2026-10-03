/**
 * Blora Design 2.0 - Copy controller (clipboard only).
 * Text-rotate lives in @bloret-crew/blora-design-effects — not here.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_COPY_TAG = "blora-copy";
export interface CopyController {
    destroy(): void;
}
export declare function createCopyController(root: HTMLElement): CopyController;
/** Copy-to-clipboard CE that owns code and action markup. */
export declare class BloraCopy extends BloraElement {
    private controller;
    private initialText;
    private revealed;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    copy(): void;
    protected render(): void;
    private updateMaskedDisplay;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraCopy(registry?: CustomElementRegistry): void;
//# sourceMappingURL=copy.d.ts.map