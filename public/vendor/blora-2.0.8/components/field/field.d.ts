/**
 * Blora Design 2.0 - Field controller
 * v1 text-limit: overflow characters highlighted red via mirror layer.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_FIELD_TAG = "blora-field";
export interface FieldController {
    destroy(): void;
}
export declare function createFieldController(root: HTMLElement): FieldController;
/** Form field CE that owns label, native control and feedback structure. */
export declare class BloraField extends BloraElement {
    private controller;
    private reflecting;
    private readonly controlId;
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
export declare function defineBloraField(registry?: CustomElementRegistry): void;
//# sourceMappingURL=field.d.ts.map