/**
 * Tree controller — expand/collapse with measured content height (symmetric open/close).
 * No hard-coded max-height caps.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TREE_TAG = "blora-tree";
export interface TreeController {
    destroy(): void;
}
export declare function createTreeController(root: HTMLElement): TreeController;
/** Tree CE that consumes nested `<blora-tree-node>` definitions. */
export declare class BloraTree extends BloraElement {
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
export declare function defineBloraTree(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tree.d.ts.map