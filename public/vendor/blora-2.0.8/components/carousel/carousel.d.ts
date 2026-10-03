/**
 * Blora Design 2.0 - Carousel controller
 * Arrows/dots + pointer/touch drag swipe (v1 parity).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CAROUSEL_TAG = "blora-carousel";
export interface CarouselController {
    destroy(): void;
    next(): void;
    prev(): void;
    goTo(i: number): void;
}
export declare function createCarouselController(root: HTMLElement): CarouselController;
/** Carousel CE that consumes declarative slides and owns navigation controls. */
export declare class BloraCarousel extends BloraElement {
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
export declare function defineBloraCarousel(registry?: CustomElementRegistry): void;
//# sourceMappingURL=carousel.d.ts.map