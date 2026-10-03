/**
 * Progress: set value via data-value or API.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_PROGRESS_TAG = "blora-progress";
export interface ProgressController {
    setValue(n: number): void;
    destroy(): void;
}
export declare function createProgressController(root: HTMLElement): ProgressController;
/** Progress CE that owns accessible label, track and fill structure. */
export declare class BloraProgress extends BloraElement {
    private controller;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string): void;
    get value(): number;
    set value(value: number);
    setValue(value: number): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraProgress(registry?: CustomElementRegistry): void;
//# sourceMappingURL=progress.d.ts.map