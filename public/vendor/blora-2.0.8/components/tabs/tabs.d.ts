/**
 * Blora Design 2.0 - Tabs controller
 *
 * Spec §17.3: Tabs with indicator animation and panel fade-in.
 * Ported from v1 initTabs, adapted as a destroyable headless controller.
 *
 * The CSS-only base works without this controller (tabs get a static
 * background in pills mode). When the controller is active it creates a
 * sliding indicator element and adds `data-tabs-enhanced` to the root so
 * CSS switches to the animated indicator.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TABS_TAG = "blora-tabs";
export interface TabsController {
    /** Activate a specific tab by index. */
    select(index: number, focus?: boolean): void;
    /** Destroy the controller, removing all listeners and the indicator. */
    destroy(): void;
}
/**
 * Create a tabs controller on a `.blora-tabs` root element.
 *
 * - Creates a `.blora-tabs__indicator` element inside the nav.
 * - Handles click and keyboard navigation (APG tabs pattern).
 * - Moves the indicator with smooth CSS transitions.
 * - Fades panels in on switch via `data-entering` attribute.
 * - Repositions the indicator on resize via ResizeObserver.
 * - Cleans up all listeners and observers on `destroy()`.
 */
export declare function createTabsController(root: HTMLElement): TabsController;
/** Composite CE. Child `<blora-tab>` definitions become the supported tablist/panel tree. */
export declare class BloraTabs extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    private readonly instanceId;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    select(index: number, focus?: boolean): void;
    protected render(): void;
    protected bindEvents(): void;
    protected sync(): void;
    protected onDisconnect(): void;
    private readDefinitions;
    private syncChrome;
    private activateFromValue;
    private reflectValueFromIndex;
    private reflectValue;
}
export declare function defineBloraTabs(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tabs.d.ts.map