/**
 * CDN / classic-script global build entry.
 * Attaches a `Blora` object on `globalThis` with main package exports + CE define helpers.
 */
import * as api from "../index.js";
export type BloraGlobal = typeof api & {
    autoDefine(): void;
};
declare const Blora: BloraGlobal;
export default Blora;
//# sourceMappingURL=global.d.ts.map