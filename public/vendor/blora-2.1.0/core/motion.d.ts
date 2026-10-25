/**
 * Read the longest computed transition on an element. Used only to wait for
 * CSS enter/leave to finish before tearing down overlay hosts — not to drive
 * the motion itself.
 */
export declare function motionDurationMs(el: Element): number;
/** Run `done` after the element's transitions finish, or immediately if none. */
export declare function whenMotionDone(el: Element, done: () => void): () => void;
//# sourceMappingURL=motion.d.ts.map