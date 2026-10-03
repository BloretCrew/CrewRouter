import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SWITCH_TAG = "blora-switch";
/** Switch CE backed by a real light-DOM checkbox. */
export declare class BloraSwitch extends BloraElement {
    static formAssociated: boolean;
    private internals;
    private initialLabel;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get checked(): boolean;
    set checked(checked: boolean);
    get value(): string;
    set value(value: string);
    focus(options?: FocusOptions): void;
    private syncFormValue;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraSwitch(registry?: CustomElementRegistry): void;
//# sourceMappingURL=switch.d.ts.map