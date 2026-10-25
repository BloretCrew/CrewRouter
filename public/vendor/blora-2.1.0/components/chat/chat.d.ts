import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_CHAT_TAG = "blora-chat";
export declare class BloraChat extends BloraElement {
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
}
export declare function defineBloraChat(registry?: CustomElementRegistry): void;
//# sourceMappingURL=chat.d.ts.map