/**
 * Blora Design 2.0 - Rate controller
 * Click stars to set rating, hover to preview.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_RATE_TAG = "blora-rate";
export interface RateController {
    destroy(): void;
}
export declare function createRateController(root: HTMLElement): RateController;
/** Rating CE that generates the official star collection. */
export declare class BloraRate extends BloraElement {
    private controller;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    get value(): number;
    set value(value: number);
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraRate(registry?: CustomElementRegistry): void;
//# sourceMappingURL=rate.d.ts.map