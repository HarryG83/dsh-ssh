/**
 * The 「新建连接」form: one SSH connection with password or private-key
 * authentication (二选一), an optional ProxyJump chain, and `~/.ssh/config`
 * alias recognition through the Host channel. The host field is alias-first:
 * blur or paste auto-resolves and prefills (the manual 「识别 ssh 配置」 button
 * stays as the loud fallback), and a successful resolve shows a one-line
 * summary (alias → user@host:port, identity file, jump chain). A `draft`
 * prefills the form — the sidebar opens it this way when a config host needs
 * its username or auth completed.
 */
import type { ConnectionView } from './index.ts';
/** One manual or resolved ProxyJump hop. */
export interface JumpInput {
    host: string;
    port?: number;
    username?: string;
    privateKeyPath?: string;
    agent?: string;
}
/** The connection input the form assembles. */
export interface ConnectionInputWire {
    label?: string;
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    agent?: string;
    jump?: JumpInput[];
    cwd?: string;
}
/** The Host's `~/.ssh/config` resolution result. */
export interface ResolvedSshConfigView {
    host: string;
    username: string;
    port: number;
    privateKeyPaths: string[];
    jump: JumpInput[];
    alias: string;
}
/** Prefilled fields for a form opened from the sidebar (config host / auth fix). */
export interface ConnectionDraft {
    label?: string;
    host?: string;
    port?: string;
    username?: string;
    privateKeyPath?: string;
    jumpText?: string;
    cwd?: string;
    /** Focus the username field on open (the missing piece the user must fill). */
    focusUsername?: boolean;
}
export interface ConnectionFormProps {
    /** Resolve a host alias against the Host's `~/.ssh/config`. */
    resolve(host: string): Promise<ResolvedSshConfigView>;
    /** Test the assembled input without persisting. */
    test(input: ConnectionInputWire): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** Persist the assembled input; the added view arrives through `onSaved`. */
    save(input: ConnectionInputWire): Promise<{
        ok: boolean;
        message?: string;
        view?: ConnectionView;
    }>;
    /** Prefilled fields, when the sidebar opened the form for one config host. */
    draft?: ConnectionDraft | undefined;
    /** The operator dismissed the form. */
    onClose(): void;
    /** A connection was saved; the flow switches the browser to it. */
    onSaved(view: ConnectionView): void;
}
/** The connection form modal (masked password, 密码/私钥二选一). */
export declare function ConnectionForm({ resolve, test, save, draft, onClose, onSaved }: ConnectionFormProps): import("react").JSX.Element;
