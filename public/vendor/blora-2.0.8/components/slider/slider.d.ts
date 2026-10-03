/**
 * Blora Design 2.0 - Slider controller
 * Value display, track fill, optional tooltip-on-drag (data-tooltip).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SLIDER_TAG = "blora-slider";
export interface SliderController {
    destroy(): void;
}
export declare function createSliderController(root: HTMLElement): SliderController;
/** Range input CE that owns the official slider structure. */
export declare class BloraSlider extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private reflecting;
    private internals;
    /** Submitted under `name` via ElementInternals; inner input stays unnamed. */
    private syncFormValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): number;
    set value(value: number);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSlider(registry?: CustomElementRegistry): void;
//# sourceMappingURL=slider.d.ts.map