import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_MOCKUP_TAG = "blora-mockup";
export declare class BloraMockup extends BloraElement {
    private content;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraMockup(registry?: CustomElementRegistry): void;
//# sourceMappingURL=mockup.d.ts.map