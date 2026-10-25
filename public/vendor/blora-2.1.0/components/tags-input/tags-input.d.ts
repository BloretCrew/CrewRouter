/**
 * Blora Design 2.0 - Tags Input controller
 * Enter/comma adds tags; close button removes.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TAGS_INPUT_TAG = "blora-tags-input";
export interface TagsInputController {
    destroy(): void;
}
export declare function createTagsInputController(root: HTMLElement): TagsInputController;
/** Tags input CE that owns tag and input markup. */
export declare class BloraTagsInput extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private reflecting;
    private internals;
    /** Submitted as one comma-joined entry matching the `values` attribute format. */
    private syncFormValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get values(): string[];
    set values(values: string[]);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTagsInput(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tags-input.d.ts.map