/**
 * Connection registry for the web channel: persisted multi-connection state
 * plus `~/.ssh/config` awareness. The `ssh://<id>/<path>` routing used by the
 * directory browser and (later) the fs/subprocess providers resolves through
 * this service, so every surface shares one live connection per entry.
 * @module dsh-ssh/registry
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SshConnection } from './connection.ts';
/** Registry plugin config. */
export interface RegistryConfig {
    /** Persisted state file; defaults to `<dsh home>/dsh-ssh-connections.json`. */
    stateFile?: string;
}
/** Client-facing view of one registered connection (no secrets). */
export interface SshConnectionView {
    id: string;
    label: string;
    host: string;
    port: number;
    username: string;
    cwd?: string;
    auth: 'password' | 'key' | 'agent';
    jumpHosts: string[];
}
/** One exact `~/.ssh/config` Host alias as the sidebar lists it. */
export interface SshConfigHostView {
    /** The exact alias as spelled in the config (no wildcards). */
    alias: string;
    /** The resolved HostName, or the alias when none is configured. */
    host: string;
    /** The block's User; empty when the config does not specify one. */
    username: string;
    port: number;
    /** Whether the block lists at least one IdentityFile. */
    identityFile: boolean;
    /** Whether the block lists a ProxyJump chain. */
    jump: boolean;
}
/** One ProxyJump hop after `~/.ssh/config` resolution. */
export interface ResolvedJump {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    agent?: string;
}
/** The result of resolving a host alias against `~/.ssh/config`. */
export interface ResolvedSshConfig {
    host: string;
    username: string;
    port: number;
    privateKeyPaths: string[];
    jump: ResolvedJump[];
}
/** Payload the channel accepts for a new connection. */
export interface ConnectionInput {
    label?: string;
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    agent?: string;
    jump?: ResolvedJump[];
    cwd?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        sshRegistry: SshRegistry;
    }
}
/** The `ssh://<id>/<path>` routing result shared by browsers and providers. */
export interface SshRoute {
    connection: SshConnection;
    /** Absolute POSIX path on the remote host. */
    path: string;
}
/** Parse `ssh://<connId>/<abs>` (the workspace/cwd spelling of a remote path). */
export declare function parseSshRoute(value: string): {
    id: string;
    path: string;
} | null;
/**
 * Connection registry service. Persisted entries live in a JSON state file;
 * live `SshConnection` instances are created lazily and share one chain per
 * entry. Secret fields (password, passphrase) are persisted verbatim because
 * the operator asked for remembered connections — the file lives under the
 * DSH home directory.
 */
export declare class SshRegistry extends Service {
    static Config: z<RegistryConfig>;
    private readonly stateFile;
    private readonly sshConfigPath;
    private readonly specs;
    private readonly live;
    private nextId;
    private writeTail;
    constructor(ctx: Context, config: RegistryConfig);
    /** All registered connections as secret-free views, in insertion order. */
    list(): SshConnectionView[];
    /** The live connection for one entry, created on first use. */
    get(id: string): SshConnection | undefined;
    /** Resolve a `ssh://<id>/<path>` cwd/path into its live connection and remote path. */
    route(value: string): SshRoute | undefined;
    /** Validate, resolve, persist, and register one new connection. */
    add(input: ConnectionInput): {
        id: string;
        view: SshConnectionView;
    };
    /** Remove one entry and its live connection. Unknown ids are a no-op. */
    remove(id: string): boolean;
    /** Test one input without persisting: connect, run `true`, and dispose. */
    test(input: ConnectionInput): Promise<{
        ok: true;
    } | {
        ok: false;
        message: string;
    }>;
    /** Resolve a hostname (possibly a `~/.ssh/config` alias) into its effective config. */
    resolveSshConfig(host: string, depth?: number): ResolvedSshConfig;
    /**
     * List the exact `~/.ssh/config` Host aliases for the sidebar, re-reading the
     * file on every call so edits between two openings are picked up. Wildcard
     * and negated patterns stay hidden; each alias carries its resolved
     * username/port plus IdentityFile / ProxyJump presence.
     */
    listConfigHosts(): SshConfigHostView[];
    /** Re-read `~/.ssh/config`; an absent or unreadable file reads as empty. */
    private readConfigEntries;
    /** Resolve against one fixed snapshot of the config (jump hops share it). */
    private resolveAgainst;
    /** Load persisted state; a missing or corrupt file starts empty. */
    private load;
    /** Persist the registry (serialized behind the previous write). */
    private persist;
    /** Project one spec into its secret-free wire view. */
    private viewOf;
}
export default SshRegistry;
