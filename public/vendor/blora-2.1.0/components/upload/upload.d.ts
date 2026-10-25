/**
 * Blora Design 2.0 - Upload controller
 * Click dropzone opens file picker; lists selected file names.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_UPLOAD_TAG = "blora-upload";
export interface UploadController {
    destroy(): void;
}
export declare function createUploadController(root: HTMLElement): UploadController;
/** File upload CE that owns dropzone, file input and selected-file list. */
export declare class BloraUpload extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private internals;
    /** Submitted as File entries under `name` via ElementInternals. */
    private syncFormValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    get files(): FileList | null;
    focus(options?: FocusOptions): void;
    open(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraUpload(registry?: CustomElementRegistry): void;
//# sourceMappingURL=upload.d.ts.map