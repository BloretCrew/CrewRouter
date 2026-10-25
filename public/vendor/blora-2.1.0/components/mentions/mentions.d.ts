/**
 * Mentions: suggestion list next to the typed @ (caret), with viewport flip / clamp.
 * Menu is portaled to document.body so Storybook transforms cannot trap fixed coords.
 *
 * Options may be plain strings or rich objects (avatar + name + secondary tag),
 * composed with `.blora-avatar` / muted meta — no extra packages required.
 */
import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_MENTIONS_TAG = "blora-mentions";
export interface MentionsController {
    destroy(): void;
}
/** Rich option for @ menus (avatar + label + optional secondary tag). */
export interface MentionOption {
    /** Inserted after @ (required). */
    value: string;
    /** Primary display name; defaults to value. */
    label?: string;
    /** Initials or short text inside `.blora-avatar` when no image. */
    initials?: string;
    /** Image URL for avatar (preferred over initials). */
    avatar?: string;
    /** Avatar color variant: primary | neutral | info | success | contrast */
    avatarVariant?: "primary" | "neutral" | "info" | "success" | "contrast";
    /** Secondary line / trailing tag (role, org, note…). */
    tag?: string;
    /** Extra search tokens (not shown). */
    keywords?: string;
}
export declare function createMentionsController(root: HTMLElement): MentionsController;
/** Mentions CE that owns its field and consumes declarative mention definitions. */
export declare class BloraMentions extends BloraElement {
    private controller;
    private options;
    private reflecting;
    static get observedAttributes(): string[];
    attributeChangedCallback(): void;
    get value(): string;
    set value(value: string);
    focus(): void;
    protected render(): void;
    protected sync(): void;
    protected bindEvents(): void;
    protected onDisconnect(): void;
}
export declare function defineBloraMentions(registry?: CustomElementRegistry): void;
//# sourceMappingURL=mentions.d.ts.map