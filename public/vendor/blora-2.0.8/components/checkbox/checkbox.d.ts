/**
 * Checkbox group: data-blora-checkall master toggle (v1 initCheckbox).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CHECKBOX_TAG = "blora-checkbox";
export interface CheckboxController {
    destroy(): void;
}
export declare function createCheckboxController(root: HTMLElement): CheckboxController;
/** Native checkbox CE; optional child definitions create a check-all group. */
export declare class BloraCheckbox extends BloraElement {
    static formAssociated: boolean;
    private internals;
    private controller;
    private definitions;
    private initialLabel;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get checked(): boolean;
    set checked(checked: boolean);
    get values(): string[];
    focus(options?: FocusOptions): void;
    private syncFormValue;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
    private createCheckbox;
    private captureLiveState;
    private syncIndeterminate;
}
export declare function defineBloraCheckbox(registry?: CustomElementRegistry): void;
//# sourceMappingURL=checkbox.d.ts.map