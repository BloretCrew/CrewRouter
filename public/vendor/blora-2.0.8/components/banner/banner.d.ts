import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_BANNER_TAG = "blora-banner";
export declare class BloraBanner extends BloraElement {
    private definitions;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraBanner(registry?: CustomElementRegistry): void;
//# sourceMappingURL=banner.d.ts.map