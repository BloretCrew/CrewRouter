export { registerBloraIcons } from "./icons-registry.js";
/** Curated names (autocompleted) plus any string — full set arrives at runtime. */
export type BloraIconName = "arrow-down" | "arrow-down-up" | "arrow-up" | "ban" | "calendar" | "camera" | "chart" | "check" | "chevron-down" | "chevron-left" | "chevron-right" | "circle-alert" | "circle-check" | "clock" | "close" | "copy" | "document" | "document-add" | "ellipsis" | "eye" | "eye-off" | "flame" | "folder" | "grip" | "heart" | "home" | "image" | "inbox" | "info" | "key" | "mail" | "menu" | "message" | "mic" | "minus" | "moon" | "palette" | "pencil" | "phone" | "plus" | "search" | "settings" | "share" | "smile" | "sparkles" | "star" | "sun" | "thumbs-up" | "trash" | "triangle-alert" | "upload" | "user" | (string & {});
/** Create a decorative, currentColor icon without parsing HTML strings. */
export declare function createBloraIcon(name: BloraIconName, size?: number, doc?: Document): SVGSVGElement;
export declare function isBloraIconName(name: string): name is BloraIconName;
//# sourceMappingURL=icons.d.ts.map