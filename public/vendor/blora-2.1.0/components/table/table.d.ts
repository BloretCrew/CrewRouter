export interface TableColConfig {
    key: string;
    label: string;
    visible: boolean;
    index: number;
}
export type TableRowData = Array<string | number | null | undefined> | Record<string, unknown>;
export interface TableController {
    setPage(page: number): void;
    getPage(): number;
    getPageCount(): number;
    /** Virtual mode: replace row data source and re-render window */
    setRows(data: TableRowData[], keys?: string[]): void;
    getColumnConfig(): TableColConfig[];
    setColumnVisible(key: string, visible: boolean): void;
    resetColumns(): void;
    /** Rows with checked row-select (visible only) */
    getSelectedRows(): HTMLTableRowElement[];
    clearSelection(): void;
    destroy(): void;
}
export interface TableControllerOptions {
    pageSize?: number;
    /** Enable column panel when host has data-blora-cols (default true if attr present) */
    columns?: boolean;
    /** Enable row selection column (default true if host has data-blora-selectable) */
    selectable?: boolean;
}
export declare function createTableController(root: HTMLElement, options?: TableControllerOptions): TableController;
//# sourceMappingURL=table.d.ts.map