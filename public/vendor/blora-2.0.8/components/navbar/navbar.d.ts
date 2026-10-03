import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_NAVBAR_TAG = "blora-navbar";
export declare class BloraNavbar extends BloraElement {
    private definitions;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraNavbar(registry?: CustomElementRegistry): void;
//# sourceMappingURL=navbar.d.ts.map