/**
 * Blora Design 2.0 - Cascader controller
 * Multi-level selection dropdown with nested options.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CASCADER_TAG = "blora-cascader";
export interface CascaderController {
    destroy(): void;
}
export interface CascaderNode {
    label: string;
    children?: CascaderNode[];
}
export declare function createCascaderController(root: HTMLElement): CascaderController;
/** Cascader CE that owns its trigger, columns and selection result. */
export declare class BloraCascader extends BloraElement {
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
export declare function defineBloraCascader(registry?: CustomElementRegistry): void;
//# sourceMappingURL=cascader.d.ts.map