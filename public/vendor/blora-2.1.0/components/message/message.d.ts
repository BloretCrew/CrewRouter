/**
 * Message service — Ant Design style floating pills (top-center).
 *
 * Visual: `.blora-message` (same CSS as static inline pills).
 * Pair with Notification (card + title/desc + corner placement).
 * There is no separate Toast product API in Blora 2.0.
 */
export type MessageType = "info" | "success" | "warning" | "danger";
export interface MessageOptions {
    /** Body text (Ant: content) */
    content?: string;
    /** Alias of `content` (optional) */
    message?: string;
    type?: MessageType | "error";
    /** Auto-close ms; 0 = stay until closed. Default 3000. */
    duration?: number;
}
export interface MessageHandle {
    close(): void;
    el: HTMLElement;
}
export interface MessageApi {
    (opts: MessageOptions | string): MessageHandle | null;
    open(opts: MessageOptions): MessageHandle | null;
    success(content: string, duration?: number): MessageHandle | null;
    info(content: string, duration?: number): MessageHandle | null;
    warning(content: string, duration?: number): MessageHandle | null;
    danger(content: string, duration?: number): MessageHandle | null;
    /** Ant alias → `danger` */
    error(content: string, duration?: number): MessageHandle | null;
}
/** Build the exact static pill used by the floating service. */
export declare function createMessageElement(opts: MessageOptions | string, doc?: Document): HTMLElement;
export declare const message: MessageApi;
//# sourceMappingURL=message.d.ts.map