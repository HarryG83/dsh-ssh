/**
 * Shared UI utilities for the dsh-ssh client: a class-name joiner and the
 * dialog behavior every modal reuses — a document-level close stack (Esc
 * always dismisses the topmost dialog only), a Tab focus trap, initial focus,
 * and focus restoration. No external focus-management dependency.
 */
import type { RefObject } from 'react';
/** Join truthy class-name fragments; false/null/undefined drop out. */
export declare const cx: (...parts: Array<string | false | null | undefined>) => string;
/**
 * Dialog accessibility behavior for one modal while `active`.
 * Returns the ref to place on the dialog element.
 */
export declare function useDialogA11y(active: boolean, onClose: () => void): RefObject<HTMLDivElement>;
