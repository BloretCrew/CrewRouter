/**
 * Tree Select: combobox with hierarchical options (v1 initTreeSelect primary path).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_TREE_SELECT_TAG = "blora-tree-select";
export interface TreeSelectController {
    open(): void;
    close(): void;
    getValue(): string;
    setValue(value: string, label?: string): void;
    destroy(): void;
}
export interface TreeSelectOption {
    label?: string;
    value?: string;
    disabled?: boolean;
    selectable?: boolean;
    children?: TreeSelectOption[];
}
export declare function createTreeSelectController(root: HTMLElement): TreeSelectController;
/** Tree Select CE that owns the combobox and hierarchical option panel. */
export declare class BloraTreeSelect extends BloraElement {
    private controller;
    private options;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraTreeSelect(registry?: CustomElementRegistry): void;
//# sourceMappingURL=tree-select.d.ts.map