import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_DRAWER_TAG = "blora-drawer";
export interface DrawerController {
    open(): void;
    close(): void;
    destroy(): void;
}
export declare function createDrawerController(root: HTMLElement, host?: HTMLElement): DrawerController;
/** Bind buttons [data-blora-drawer-open="id"] to drawers by id. */
export declare function bindDrawerTriggers(root?: ParentNode): () => void;
/** Drawer CE that owns mask, panel, header and body structure. */
export declare class BloraDrawer extends BloraElement {
    private controller;
    private contentNodes;
    private relocating;
    private home;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    disconnectedCallback(): void;
    protected onDisconnect(): void;
    private portalToBody;
    private restoreHome;
}
export declare function defineBloraDrawer(registry?: CustomElementRegistry): void;
//# sourceMappingURL=drawer.d.ts.map