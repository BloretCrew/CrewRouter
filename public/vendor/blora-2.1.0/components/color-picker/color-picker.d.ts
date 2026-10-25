/**
 * Blora Design 2.0 - Color Picker (HSV spectrum + hex sync, v1 parity)
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_COLOR_PICKER_TAG = "blora-color-picker";
export interface ColorPickerController {
    destroy(): void;
}
export declare function createColorPickerController(root: HTMLElement): ColorPickerController;
/** HSV color picker CE that owns swatch, spectrum, hue and hex controls. */
export declare class BloraColorPicker extends BloraElement {
    private controller;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraColorPicker(registry?: CustomElementRegistry): void;
//# sourceMappingURL=color-picker.d.ts.map