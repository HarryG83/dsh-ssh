/** SSH PTY allocation and process-session ownership for the subprocess seam. */
import { PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import type { SubprocessOutcome, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { SshTransport } from './transport.ts';
/** One SSH PTY and its remote login shell, projected onto the subprocess terminal seam. */
export declare class SshTerminalHandle implements SubprocessTerminalHandle {
    private readonly channel;
    private readonly graceMs;
    readonly pid = -1;
    readonly output: PassThrough;
    readonly done: Promise<SubprocessOutcome>;
    private topLevelExited;
    private cleanup;
    /**
     * @param channel - the allocated SSH shell channel.
     * @param graceMs - TERM-to-KILL and exit-wait grace.
     */
    constructor(channel: ClientChannel, graceMs: number);
    /** @inheritdoc */
    write(data: string): Promise<void>;
    /** The SSH channel does not expose a foreground process group. */
    inspectForeground(): Promise<SubprocessTerminalForeground | undefined>;
    /** @inheritdoc */
    signalForeground(_signal: SubprocessTerminalSignal): Promise<number>;
    /** @inheritdoc */
    terminate(): Promise<void>;
    private signal;
    private waitForClose;
    private closeOnce;
}
/**
 * Allocate an SSH PTY, replace its login shell with the requested argv, and
 * return the live terminal handle.
 * @param ssh - connection owner backing this execution world.
 * @param cwd - resolved absolute remote working directory.
 * @param spec - fully specified terminal-process request.
 * @returns the live terminal handle after allocation succeeds.
 */
export declare function spawnSshTerminal(ssh: SshTransport, cwd: string, spec: SubprocessTerminalSpawnSpec): Promise<SshTerminalHandle>;
