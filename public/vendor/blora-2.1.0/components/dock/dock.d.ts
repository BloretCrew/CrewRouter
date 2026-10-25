/**
 * Blora Design 2.0 - Dock controller only.
 * Megamenu → components/megamenu; Speed Dial → components/speed-dial.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_DOCK_TAG = "blora-dock";
export interface DockController {
    destroy(): void;
    getCurrent(): number;
    select(index: number): void;
}
/**
 * Dock: active state + sliding indicator (segmented-style).
 */
export declare function createDockController(root: HTMLElement): DockController;
/** Dock CE that consumes declarative items and owns the sliding indicator. */
export declare class BloraDock extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get current(): number;
    set current(index: number);
    select(index: number): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraDock(registry?: CustomElementRegistry): void;
//# sourceMappingURL=dock.d.ts.map