/**
 * BloraElement - thin base class for Blora custom elements.
 * Spec §10.1: minimal, no i18n/table/overlay/form/validation/global-state.
 * Spec §3.5: SSR-safe - importing must not throw without DOM globals.
 */
declare const DOMBaseClass: typeof HTMLElement;
export declare abstract class BloraElement extends DOMBaseClass {
    protected abortController: AbortController;
    private _isConnected;
    private _connectScheduled;
    private _mounted;
    protected get isConnectedInternal(): boolean;
    protected get hasMounted(): boolean;
    connectedCallback(): void;
    private connectNow;
    disconnectedCallback(): void;
    protected listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
    protected emit<T>(name: string, detail: T, options?: CustomEventInit<T>): boolean;
    protected abstract render(): void;
    protected abstract bindEvents(): void;
    /** Patch the existing official tree after reconnect or a non-structural attribute change. */
    protected sync(): void;
    /** Chrome strings follow `setLocale` / `html lang` without remounting. */
    protected onLocaleChange(): void;
    protected onDisconnect(): void;
    /** Re-attach listeners/controllers without rebuilding the official tree. */
    protected rebind(): void;
    private upgradeProperties;
}
export {};
//# sourceMappingURL=blora-element.d.ts.map