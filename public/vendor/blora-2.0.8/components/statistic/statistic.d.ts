import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_STATISTIC_TAG = "blora-statistic";
/** Attribute-driven statistic that owns the official `.blora-stat` tree. */
export declare class BloraStatistic extends BloraElement {
    private initialValue;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraStatistic(registry?: CustomElementRegistry): void;
//# sourceMappingURL=statistic.d.ts.map