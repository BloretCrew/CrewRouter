/**
 * OverlayController - unified overlay management.
 * Spec §12.1-12.2: portal, z-index, outside click, Escape,
 * focus return, focus trap, scroll lock, overlay stack.
 */
export interface OverlayOptions {
    modal: boolean;
    closeOnEscape: boolean;
    closeOnOutsidePointer: boolean;
    restoreFocus: boolean;
    trapFocus: boolean;
    lockScroll: boolean;
}
export declare class OverlayController {
    private entry;
    private readonly overlay;
    private readonly options;
    constructor(overlay: HTMLElement, options?: Partial<OverlayOptions>);
    open(): void;
    close(): void;
    private onKeyDown;
    private onPointerDown;
    destroy(): void;
}
//# sourceMappingURL=overlay-controller.d.ts.map