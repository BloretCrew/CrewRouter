import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_NUMBER_INPUT_TAG = "blora-number-input";
export declare class BloraNumberInput extends BloraElement {
    static formAssociated: boolean;
    private internals;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): number;
    set value(value: number);
    focus(options?: FocusOptions): void;
    protected render(): void;
    private makeButton;
    protected sync(): void;
    protected bindEvents(): void;
    private reflectValue;
}
export declare function defineBloraNumberInput(registry?: CustomElementRegistry): void;
//# sourceMappingURL=number-input.d.ts.map