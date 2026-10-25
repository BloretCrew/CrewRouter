export type NotificationPlacement = "top-right" | "top-left" | "bottom-right" | "bottom-left";
type NotificationType = "success" | "warning" | "danger" | "info";
export interface NotificationOptions {
    title?: string;
    description?: string;
    type?: NotificationType | "error";
    duration?: number;
    placement?: NotificationPlacement;
}
export interface NotificationHandle {
    close(): void;
    el: HTMLElement;
}
/** Build the exact notification card used by notify(). */
export declare function createNotificationElement(opts: NotificationOptions | string, doc?: Document): HTMLElement;
export declare function notify(opts: NotificationOptions | string): NotificationHandle | null;
export declare function createNotificationController(root: HTMLElement): {
    destroy(): void;
};
export {};
//# sourceMappingURL=notification.d.ts.map