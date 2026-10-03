/**
 * Blora Design 2.0 - Calendar controller
 * Month/year navigation, day selection, zoom levels (days → months → years).
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CALENDAR_TAG = "blora-calendar";
export interface CalendarController {
    destroy(): void;
}
export declare function createCalendarController(root: HTMLElement): CalendarController;
/** Calendar CE that owns the complete navigation and date grid. */
export declare class BloraCalendar extends BloraElement {
    private controller;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraCalendar(registry?: CustomElementRegistry): void;
//# sourceMappingURL=calendar.d.ts.map