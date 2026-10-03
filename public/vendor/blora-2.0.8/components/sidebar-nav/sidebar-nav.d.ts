import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SIDEBAR_NAV_TAG = "blora-sidebar-nav";
export interface BloraSidebarNavChangeDetail {
    href: string;
    value: string;
}
/** Grouped sidebar navigation with one controlled current page. */
export declare class BloraSidebarNav extends BloraElement {
    private definitions;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    get value(): string;
    set value(value: string);
    select(value: string): void;
    protected render(): void;
    protected bindEvents(): void;
    private readDefinitions;
    private readLink;
    private syncCurrent;
}
export declare function defineBloraSidebarNav(registry?: CustomElementRegistry): void;
//# sourceMappingURL=sidebar-nav.d.ts.map