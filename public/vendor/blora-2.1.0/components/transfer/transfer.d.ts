/**
 * Blora Design 2.0 - Transfer controller
 * Moves checked items between source and target panels.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TRANSFER_TAG = "blora-transfer";
export interface TransferController {
    destroy(): void;
}
export declare function createTransferController(root: HTMLElement): TransferController;
/** Composite CE. Child `<blora-transfer-item>` definitions are converted to official rows. */
export declare class BloraTransfer extends BloraElement {
    private controller;
    private definitions;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get selectedValues(): string[];
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTransfer(registry?: CustomElementRegistry): void;
//# sourceMappingURL=transfer.d.ts.map