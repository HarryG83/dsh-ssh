/**
 * Browser half of dsh-ssh: the add-workspace directory flow — a connection
 * sidebar (saved connections, `~/.ssh/config` hosts, local entry) beside the
 * directory browser. Registered into both directory-flow holes, so mounting
 * `dsh-ssh` composes the whole picking interaction. Cross-plane calls ride the
 * shared web transport: local listing through the client directory API
 * (`uiWorkspace`, falling back to `workspaces` — the Host's `directoryPicker`
 * browse capability) and remote listing/connection
 * management through the package's `/dsh-ssh` RPC channel.
 */
import type { Context } from '@deepseek-ai/cordis';
/** Local, self-contained wire contracts (no cross-plugin value imports). */
export interface WireEntry {
    name: string;
    path: string;
    hidden: boolean;
}
export interface WireListing {
    path: string;
    home: string;
    crumbs: WireEntry[];
    entries: WireEntry[];
    truncated: boolean;
}
export interface ConnectionView {
    id: string;
    label: string;
    host: string;
    port: number;
    username: string;
    cwd?: string;
    auth: 'password' | 'key' | 'agent';
    jumpHosts: string[];
}
/** One exact `~/.ssh/config` Host alias (the `config.hosts` wire row). */
export interface ConfigHostView {
    alias: string;
    host: string;
    username: string;
    port: number;
    identityFile: boolean;
    jump: boolean;
}
export type WireResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
/** The client workspace service's directory faces. */
export interface ClientWorkspaces {
    listDirectory(path?: string, signal?: AbortSignal): Promise<WireListing>;
    createDirectory(path: string, name: string): Promise<string>;
}
/** The client connection handle's RPC face. */
export interface ClientConnection {
    rpc: {
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WireResult>;
    };
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        slots: {
            inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void;
            register(options: {
                name: string;
                inject?: (...args: never[]) => Record<string, unknown>;
            }, component: unknown): () => void;
        };
        workspaces: ClientWorkspaces;
        uiWorkspace?: ClientWorkspaces;
    }
}
/** Required client services: the slot registry and the wire-facing workspace service. */
export declare const inject: string[];
/**
 * Client plugin body: fill both directory-flow holes with the SSH workspace
 * flow. `slots.inject` waits for each hole's declaration, and the generator
 * installs the two registrations transactionally.
 * @param ctx - client root context.
 */
export declare function apply(ctx: Context): void;
