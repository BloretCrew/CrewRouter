import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_RADIO_TAG = "blora-radio";
/** Radio CE backed by a real light-DOM `<input type="radio">`. */
export declare class BloraRadio extends BloraElement {
    private initialLabel;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get checked(): boolean;
    set checked(checked: boolean);
    get value(): string;
    set value(value: string);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraRadio(registry?: CustomElementRegistry): void;
//# sourceMappingURL=radio.d.ts.map