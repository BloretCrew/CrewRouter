/**
 * Blora Design 2.0 - Dropdown controller
 *
 * Spec §16.2: Dropdown with toggle, outside-click, and Escape close.
 * Ported from v1 initDropdown, adapted as a destroyable headless controller.
 *
 * The CSS-only base works without this controller (set `data-open` on the
 * root manually). The controller adds proper ARIA, outside-click, Escape,
 * and item-click-to-close behavior.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_DROPDOWN_TAG = "blora-dropdown";
export interface DropdownController {
    /** Open the dropdown. */
    open(): void;
    /** Close the dropdown. */
    close(): void;
    /** Toggle open/closed state. */
    toggle(): void;
    /** Destroy the controller, removing all listeners. */
    destroy(): void;
}
/**
 * Create a dropdown controller on a `.blora-dropdown` root element.
 *
 * Expected markup:
 * ```html
 * <div class="blora-dropdown">
 *   <button data-dropdown-trigger>Trigger</button>
 *   <div class="blora-dropdown__menu">...</div>
 * </div>
 * ```
 *
 * - Toggles `data-open` on the root element.
 * - Closes on outside click (document click).
 * - Closes on Escape key.
 * - Closes when a `.blora-dropdown__item` is clicked.
 * - Sets `aria-haspopup` and syncs `aria-expanded` on the trigger.
 * - Cleans up all listeners on `destroy()`.
 */
export declare function createDropdownController(root: HTMLElement): DropdownController;
/** Dropdown CE. Child item definitions become the official menu tree. */
export declare class BloraDropdown extends BloraElement {
    private controller;
    private definitions;
    private contentNodes;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    open(): void;
    close(): void;
    toggle(): void;
    private alignValue;
    private placementValue;
    private isHelper;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraDropdown(registry?: CustomElementRegistry): void;
//# sourceMappingURL=dropdown.d.ts.map