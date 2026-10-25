/**
 * Blora Design 2.0 - Datepicker controller
 * v1 parity: native type=date field (segmented locale UI)
 * + custom Blora panel opened by the trailing icon button.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_DATEPICKER_TAG = "blora-datepicker";
export interface DatepickerController {
    destroy(): void;
}
export declare function createDatepickerController(root: HTMLElement): DatepickerController;
/** Composite CE that generates the supported date field and calendar trigger. */
export declare class BloraDatepicker extends BloraElement {
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
export declare function defineBloraDatepicker(registry?: CustomElementRegistry): void;
//# sourceMappingURL=datepicker.d.ts.map