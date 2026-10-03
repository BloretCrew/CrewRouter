/**
 * Blora Design 2.0 - Speed Dial controller
 * Stays in core (product decision). Baseline: v1 initSpeedDial.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SPEED_DIAL_TAG = "blora-speed-dial";
export interface SpeedDialController {
    open(): void;
    close(): void;
    /** Flip open state; used by host-level delegation so re-rendered subtrees stay live. */
    toggle(): void;
    destroy(): void;
}
export interface SpeedDialControllerOptions {
    /** Skip the controller's own trigger click binding (host delegates instead). */
    triggerDelegated?: boolean;
}
/** v1 initSpeedDial parity: menu roles, keyboard, outside close. */
export declare function createSpeedDialController(root: HTMLElement, options?: SpeedDialControllerOptions): SpeedDialController;
/** Speed Dial CE that consumes declarative actions and owns trigger/menu controls. */
export declare class BloraSpeedDial extends BloraElement {
    private controller;
    private definitions;
    private reflecting;
    private dialTreeObserver;
    private lastToggleEvent;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    open(): void;
    close(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraSpeedDial(registry?: CustomElementRegistry): void;
//# sourceMappingURL=speed-dial.d.ts.map