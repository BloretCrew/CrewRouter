import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_RESULT_TAG = "blora-result";
export declare class BloraResult extends BloraElement {
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraResult(registry?: CustomElementRegistry): void;
//# sourceMappingURL=result.d.ts.map