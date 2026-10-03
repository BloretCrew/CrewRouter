export interface FormValidateResult {
    valid: boolean;
    errors: Array<{
        name: string;
        message: string;
        field: HTMLElement;
    }>;
    values: Record<string, string | boolean | string[]>;
}
export interface FormController {
    validate(): FormValidateResult;
    getValues(): Record<string, string | boolean | string[]>;
    clearErrors(): void;
    destroy(): void;
}
export declare function getFormValues(form: HTMLFormElement): Record<string, string | boolean | string[]>;
export declare function createFormController(form: HTMLFormElement): FormController;
//# sourceMappingURL=form.d.ts.map