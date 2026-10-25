import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_EMPTY_TAG = "blora-empty";
export declare class BloraEmpty extends BloraElement {
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraEmpty(registry?: CustomElementRegistry): void;
//# sourceMappingURL=empty.d.ts.map