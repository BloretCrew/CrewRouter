import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_ALERT_TAG = "blora-alert";
export declare class BloraAlert extends BloraElement {
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraAlert(registry?: CustomElementRegistry): void;
//# sourceMappingURL=alert.d.ts.map