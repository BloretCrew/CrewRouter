import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TOUR_TAG = "blora-tour";
export interface TourController {
    destroy(): void;
    end(): void;
    next(): void;
    prev(): void;
    start(): void;
}
export declare function createTourController(root: HTMLElement): TourController;
/** Tour CE that consumes declarative highlighted steps and owns the start control. */
export declare class BloraTour extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    start(): void;
    end(): void;
    next(): void;
    prev(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTour(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tour.d.ts.map