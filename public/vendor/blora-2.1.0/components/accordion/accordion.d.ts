/** Composite accordion Custom Element; controller remains available for advanced markup. */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_ACCORDION_TAG = "blora-accordion";
export declare class BloraAccordion extends BloraElement {
    private controller;
    private definitions;
    private readonly instanceId;
    protected render(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraAccordion(registry?: CustomElementRegistry): void;
//# sourceMappingURL=accordion.d.ts.map