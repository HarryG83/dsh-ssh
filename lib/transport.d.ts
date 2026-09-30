/**
 * Execution-world transport shared by the SSH subprocess and filesystem
 * providers. The aggregate `ctx.ssh` service is the default transport; an
 * `ssh://<connectionId>/<path>` working directory routes one operation to a
 * registry-owned connection instead, so sessions created from the web
 * connection manager execute on the host they were opened against.
 *
 * The web client cannot pass an `ssh://` cwd to `sessions.create` — the host's
 * session service unconditionally `mkdir`s the project directory through
 * `node:fs`. So each remote route also has a LOCAL placeholder directory
 * (`<dsh home>/dsh-ssh-routes/<id>/<remote path>`) that the client registers
 * and hands to `sessions.create`; both spellings route to the same registry
 * connection here.
 * @module dsh-ssh/transport
 */
import type { Client, SFTPWrapper } from 'ssh2';
import type { Context } from '@deepseek-ai/cordis';
import type { ExecOutcome } from './runtime.ts';
/** The connection-owner face both providers consume. */
export interface SshTransport {
    /** Human-readable connection target for UI surfaces (`username@host`). */
    readonly endpoint: string;
    /** The transport's default remote working directory. */
    readonly cwd: string;
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
    /** Map a caller-supplied working directory onto the transport's remote host. */
    resolveRemoteCwd(cwd: string | undefined): string;
}
/** A working directory resolved against one concrete transport. */
export interface SshCwdRoute {
    /** The transport owning the resolved remote directory. */
    transport: SshTransport;
    /** The absolute POSIX directory to execute in. */
    cwd: string;
    /** Registry connection id when the caller supplied an `ssh://` route. */
    connectionId?: string;
}
/** Build the opaque target key used by the filesystem backend for one route. */
export declare function sshTargetKey(connectionId: string, path: string): string;
/** Split a filesystem target key into its transport route and remote path. */
export declare function parseSshTargetKey(targetKey: string): {
    connectionId?: string;
    path: string;
};
/** Root of the local placeholder tree standing in for remote routes. */
export declare function sshRoutesRoot(): string;
/** The local placeholder path of one registry route (created by `session.route`). */
export declare function sshRoutePlaceholder(connectionId: string, remotePath: string): string;
/**
 * Resolve one caller cwd against the transport it names. POSIX absolute paths
 * and the normal local-path redirection stay on the aggregate `ctx.ssh`;
 * `ssh://<id>/<path>` and its local placeholder both select the live registry
 * connection for that id.
 */
export declare function resolveSshCwd(ctx: Context, cwd: string | undefined): SshCwdRoute;
/** Resolve an encoded filesystem target key against its owning transport. */
export declare function resolveSshTargetKey(ctx: Context, targetKey: string): SshCwdRoute & {
    path: string;
};
