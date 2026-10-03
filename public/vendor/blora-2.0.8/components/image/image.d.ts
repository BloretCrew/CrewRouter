import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_IMAGE_TAG = "blora-image";
export interface ImageController {
    destroy(): void;
}
export interface ImagePreviewHandle {
    close(): void;
    next(): void;
    prev(): void;
    el: HTMLElement;
}
export interface ImagePreviewItem {
    src: string;
    alt?: string;
    caption?: string;
}
export declare function openImagePreview(items: ImagePreviewItem[] | string[], start?: number): ImagePreviewHandle | null;
export declare function createImageController(root: HTMLElement): ImageController;
/** Image CE that owns figure, image, caption, loading and preview structure. */
export declare class BloraImage extends BloraElement {
    private controller;
    private previewHandle;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraImage(registry?: CustomElementRegistry): void;
//# sourceMappingURL=image.d.ts.map