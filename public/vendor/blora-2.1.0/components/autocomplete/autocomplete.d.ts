/**
 * Blora Design 2.0 - Autocomplete controller
 * Filters options from data-options and shows a dropdown.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_AUTOCOMPLETE_TAG = "blora-autocomplete";
export interface AutocompleteController {
    destroy(): void;
}
export declare function createAutocompleteController(root: HTMLElement): AutocompleteController;
/** Autocomplete CE that owns the label, search field and suggestion menu. */
export declare class BloraAutocomplete extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraAutocomplete(registry?: CustomElementRegistry): void;
//# sourceMappingURL=autocomplete.d.ts.map