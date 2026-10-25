import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CHART_CONTAINER_TAG = "blora-chart-container";
export declare class BloraChartContainer extends BloraElement {
    private content;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraChartContainer(registry?: CustomElementRegistry): void;
//# sourceMappingURL=chart-container.d.ts.map