import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SWAP_TAG = "blora-swap";
export declare class BloraSwap extends BloraElement {
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get checked(): boolean;
    set checked(checked: boolean);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraSwap(registry?: CustomElementRegistry): void;
//# sourceMappingURL=swap.d.ts.map