/**
 * SSH Service Provider for the subprocess capability seam. Each handle starts
 * through the shared SSH connection and keeps its output spill files on the
 * local host (remote bytes already arrive over the channel).
 * @module @deepseek-ai/dsh-subprocess-ssh
 */
import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** SSH command manager registered as `ctx.subprocess`. */
export declare class SshSubprocessRuntime extends SubprocessRuntime {
    static inject: string[];
    private readonly live;
    private readonly terminals;
    private readonly spillDir;
    private disposing;
    /** Create the SSH subprocess service and bind its disposal policy. */
    constructor(ctx: Context);
    /** @inheritdoc */
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    /** @inheritdoc */
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    /** @inheritdoc */
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
export default SshSubprocessRuntime;
