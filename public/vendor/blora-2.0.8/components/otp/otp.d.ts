/**
 * Blora Design 2.0 - OTP controller
 * Auto-advance, backspace, paste, mode filtering, uppercase.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_OTP_TAG = "blora-otp";
export interface OtpController {
    destroy(): void;
}
export declare function createOtpController(root: HTMLElement): OtpController;
/** One-time-password CE with generated native text inputs. */
export declare class BloraOtp extends BloraElement {
    static formAssociated: boolean;
    private controller;
    private reflecting;
    private internals;
    /** Submitted as the joined digits via ElementInternals; empty code submits nothing. */
    private syncFormValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    focus(options?: FocusOptions): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraOtp(registry?: CustomElementRegistry): void;
//# sourceMappingURL=otp.d.ts.map