/**
 * Blora Design 2.0 - Deck controller
 * Stacked cards with drag/wheel navigation (v1 parity).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_DECK_TAG = "blora-deck";
export interface DeckController {
    destroy(): void;
    next(): void;
    prev(): void;
    goTo(index: number): void;
    getCurrent(): number;
}
export declare function createDeckController(root: HTMLElement): DeckController;
/** Deck CE that consumes declarative cards and owns drag/wheel/keyboard navigation. */
export declare class BloraDeck extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get current(): number;
    set current(index: number);
    next(): void;
    prev(): void;
    goTo(index: number): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraDeck(registry?: CustomElementRegistry): void;
//# sourceMappingURL=deck.d.ts.map