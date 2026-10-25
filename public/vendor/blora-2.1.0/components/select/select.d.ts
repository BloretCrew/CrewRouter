import { BloraElement } from "../../core/blora-element.js";
export declare const BLORA_SELECT_TAG = "blora-select";
export interface BloraOptionData {
    value: string;
    label: string;
    disabled?: boolean;
}
export declare class BloraSelect extends BloraElement {
    static formAssociated: boolean;
    static get observedAttributes(): string[];
    private _internals;
    private _overlay;
    private _isOpen;
    private _activeIndex;
    private _options;
    private _value;
    private _values;
    private _trigger;
    private _popup;
    private _listbox;
    private _optionObserver;
    attributeChangedCallback(name: string, _old: string, value: string): void;
    protected render(): void;
    protected bindEvents(): void;
    get value(): string;
    set value(v: string);
    get multiple(): boolean;
    get values(): readonly string[];
    get selectedOptions(): readonly BloraOptionData[];
    get options(): readonly BloraOptionData[];
    open(): void;
    close(reason?: string): void;
    focus(): void;
    checkValidity(): boolean;
    reportValidity(): boolean;
    setCustomValidity(message: string): void;
    private _collectOptions;
    private _renderOptions;
    private _updateDisplay;
    private _selectIndex;
    private _toggleValue;
    private _updateActiveOption;
    private _onKeyDown;
    private _skipDisabled;
    protected onDisconnect(): void;
    private _initOptions;
}
export declare function defineBloraSelect(registry?: CustomElementRegistry): void;
//# sourceMappingURL=select.d.ts.map