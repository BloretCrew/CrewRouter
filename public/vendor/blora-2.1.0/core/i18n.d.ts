export type BloraMessages = Record<string, string>;
export interface BloraLocalePack {
    collator: string;
    months: string[];
    dow: string[];
    messages: BloraMessages;
}
export declare function registerLocale(tag: string, pack: BloraLocalePack): void;
export declare function setLocale(tag: string, pack?: BloraLocalePack): void;
export declare function getLocale(): string;
export declare function applyDocumentLocale(doc?: Document | null): void;
export declare function t(key: string, vars?: Record<string, string | number>): string;
export declare function localeMonths(): string[];
export declare function localeDow(): string[];
export declare function localeCollator(): string;
//# sourceMappingURL=i18n.d.ts.map