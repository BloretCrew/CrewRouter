/**
 * Blora Design 2.0 - Timepicker controller
 * Baseline: v1 initTimePicker + custom wheel panel.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TIMEPICKER_TAG = "blora-timepicker";
export interface TimepickerController {
    destroy(): void;
}
export declare function createTimepickerController(root: HTMLElement): TimepickerController;
/** Composite CE that generates the supported time field and wheel trigger. */
export declare class BloraTimepicker extends BloraElement {
    private controller;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTimepicker(registry?: CustomElementRegistry): void;
//# sourceMappingURL=timepicker.d.ts.map