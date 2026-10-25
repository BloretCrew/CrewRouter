/**
 * Blora Design 2.0 - Splitter controller
 * Draggable divider to resize two panes.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SPLITTER_TAG = "blora-splitter";
export interface SplitterController {
    destroy(): void;
    getPosition(): number;
    setPosition(percent: number): void;
}
export declare function createSplitterController(root: HTMLElement): SplitterController;
/** Splitter CE that consumes exactly two pane definitions and owns the separator. */
export declare class BloraSplitter extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get position(): number;
    set position(percent: number);
    setPosition(percent: number): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSplitter(registry?: CustomElementRegistry): void;
//# sourceMappingURL=splitter.d.ts.map