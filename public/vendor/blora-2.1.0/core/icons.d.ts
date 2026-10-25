export { registerBloraIcons } from "./icons-registry.js";
/** Curated names (autocompleted) plus any string — full set arrives at runtime. */
export type BloraIconName = "arrow-down" | "arrow-down-up" | "arrow-up" | "ban" | "bell" | "calendar" | "camera" | "chart" | "check" | "chevron-down" | "chevron-left" | "chevron-right" | "circle-alert" | "circle-check" | "circle-x" | "clock" | "close" | "copy" | "document" | "document-add" | "download" | "ellipsis" | "external-link" | "eye" | "eye-off" | "filter" | "flame" | "folder" | "grip" | "heart" | "home" | "image" | "inbox" | "info" | "key" | "link" | "lock" | "log-out" | "mail" | "menu" | "message" | "mic" | "minus" | "moon" | "palette" | "pencil" | "phone" | "plus" | "refresh-cw" | "search" | "settings" | "share" | "smile" | "sparkles" | "star" | "sun" | "thumbs-up" | "trash" | "triangle-alert" | "upload" | "user" | (string & {});
/** Create a decorative, currentColor icon without parsing HTML strings. */
export declare function createBloraIcon(name: BloraIconName, size?: number, doc?: Document): SVGSVGElement;
export declare function isBloraIconName(name: string): name is BloraIconName;
//# sourceMappingURL=icons.d.ts.map