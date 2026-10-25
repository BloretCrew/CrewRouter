import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_COMMAND_TAG = "blora-command";
export interface CommandPaletteController {
    destroy(): void;
}
export declare function createCommandPaletteController(root: HTMLElement): CommandPaletteController;
/** Composite CE that owns the command search and official result item tree. */
export declare class BloraCommand extends BloraElement {
    private controller;
    private searchController;
    private definitions;
    private relocating;
    private home;
    private cancelCloseMotion;
    private overlay;
    private hostInTopLayer;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    show(): void;
    close(): void;
    disconnectedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
    private promoteToTopLayer;
    private dismissTopLayer;
    private portalToBody;
    private restoreHome;
}
export declare function defineBloraCommand(registry?: CustomElementRegistry): void;
//# sourceMappingURL=command-palette.d.ts.map