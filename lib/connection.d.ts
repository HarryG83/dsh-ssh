/**
 * One standalone SSH connection owned by the connection registry (not the
 * `ctx.ssh` service): the same ProxyJump chain, auth, SFTP, and exec mechanics
 * as `SshRuntime`, but bound to a registry entry instead of the shared
 * service. The registry uses it for connection tests and per-connection
 * directory browsing; the `ssh://<id>/<path>` cwd routing in the providers
 * rides the same instances.
 * @module dsh-ssh/connection
 */
import { Client } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import type { ExecOutcome, JumpConfig } from './runtime.ts';
/** A registry entry as persisted in the state file. */
export interface SshConnectionSpec {
    /** Stable registry id (`c1`, `c2`, …). */
    id: string;
    /** Operator-facing display name. */
    label: string;
    /** Target hostname or address. */
    host: string;
    /** Target SSH port. */
    port: number;
    /** Remote login user. */
    username: string;
    /** Password authentication (stored verbatim; omit for key/agent auth). */
    password?: string;
    /** Local path to a PEM identity file. */
    privateKeyPath?: string;
    /** Passphrase for an encrypted private key. */
    passphrase?: string;
    /** SSH agent socket path or the `pageant` sentinel for Windows. */
    agent?: string;
    /** Ordered ProxyJump chain (same semantics as the ssh service). */
    jump?: JumpConfig[];
    /** Remote working directory; an absolute POSIX path, or absent to resolve lazily. */
    cwd?: string;
    /** Socket connect timeout in milliseconds. */
    readyTimeout?: number;
    /** TCP keepalive interval in milliseconds; 0 disables. */
    keepaliveInterval?: number;
    /** TCP keepalive retry budget before the connection is considered dead. */
    keepaliveCountMax?: number;
}
/** A registry-owned live SSH connection (jump chain + shared SFTP). */
export declare class SshConnection {
    readonly spec: SshConnectionSpec;
    readonly id: string;
    readonly label: string;
    readonly endpoint: string;
    private readonly hops;
    private readonly strict;
    private readonly knownHosts;
    private clients;
    private ready;
    private sftp;
    private sftpOpening;
    private remoteEnvironment;
    private disposed;
    /** The transport's default remote working directory. */
    get cwd(): string;
    /** Build the hop chain from a registry spec (auth defaults fall down the chain). */
    constructor(spec: SshConnectionSpec);
    /** Release the chain and the shared SFTP channel. */
    dispose(): void;
    /**
     * Map a caller-supplied working directory onto this connection's host. The
     * rules mirror {@link SshRuntime.resolveRemoteCwd}: a POSIX absolute path is
     * already remote, while a Windows drive/UNC path or the absent cwd falls
     * back to the registry entry's configured remote cwd.
     */
    resolveRemoteCwd(cwd: string | undefined): string;
    /** The authenticated target client after the jump chain succeeds. */
    getClient(signal?: AbortSignal): Promise<Client>;
    /** The shared SFTP channel, opened lazily once per connection. */
    getSftp(signal?: AbortSignal): Promise<SFTPWrapper>;
    /** The remote login environment, read once and cached. */
    getRemoteEnvironment(signal?: AbortSignal): Promise<Record<string, string>>;
    /** Run one control-plane command with collected output. */
    exec(command: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<ExecOutcome>;
    private openSftp;
    private readRemoteEnvironment;
    private open;
}
