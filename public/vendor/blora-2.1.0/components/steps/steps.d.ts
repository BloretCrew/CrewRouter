/**
 * Steps: click/keyboard to set current step (optional interactive path).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_STEPS_TAG = "blora-steps";
export interface StepsController {
    setCurrent(index: number): void;
    getCurrent(): number;
    destroy(): void;
}
export declare function createStepsController(root: HTMLElement): StepsController;
/** Composite CE. Child `<blora-step>` definitions become the official Steps tree. */
export declare class BloraSteps extends BloraElement {
    private controller;
    private definitions;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get current(): number;
    set current(index: number);
    setCurrent(index: number): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSteps(registry?: CustomElementRegistry): void;
//# sourceMappingURL=steps.d.ts.map