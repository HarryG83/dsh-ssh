/** SSH PTY allocation and process-session ownership for the subprocess seam. */
import { PassThrough } from 'node:stream';
import { quoteShellArg } from "./runtime.js";
import { readRemoteEnvironment, scrubRemoteEnvironment, serializeEnvironment } from "./environment.js";
/** Normalize an SSH signal name into the `SIG…` vocabulary the seam carries. */
function normalizeSignal(signal) {
    if (signal === null || signal === undefined)
        return null;
    return (signal.startsWith('SIG') ? signal : `SIG${signal}`);
}
/** Resolve after one duration. */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** One SSH PTY and its remote login shell, projected onto the subprocess terminal seam. */
export class SshTerminalHandle {
    channel;
    graceMs;
    pid = -1;
    output = new PassThrough();
    done;
    topLevelExited = false;
    cleanup;
    /**
     * @param channel - the allocated SSH shell channel.
     * @param graceMs - TERM-to-KILL and exit-wait grace.
     */
    constructor(channel, graceMs) {
        this.channel = channel;
        this.graceMs = graceMs;
        this.done = this.waitForClose();
    }
    /** @inheritdoc */
    write(data) {
        if (this.topLevelExited)
            return Promise.reject(new Error('terminal process has exited'));
        return new Promise((resolve, reject) => {
            this.channel.write(Buffer.from(data, 'utf8'), (error) => {
                if (error !== undefined)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    /** The SSH channel does not expose a foreground process group. */
    inspectForeground() {
        return Promise.resolve(undefined);
    }
    /** @inheritdoc */
    signalForeground(_signal) {
        return Promise.reject(new Error('subprocess-ssh: cannot resolve the foreground process group over an SSH channel'));
    }
    /** @inheritdoc */
    terminate() {
        if (this.cleanup !== undefined)
            return this.cleanup;
        const cleanup = this.closeOnce();
        this.cleanup = cleanup;
        void cleanup.catch(() => { this.cleanup = undefined; });
        return cleanup;
    }
    signal(name) {
        try {
            this.channel.signal(name);
        }
        catch (_alreadyClosed) {
            // The channel closed before the signal could be delivered.
        }
    }
    async waitForClose() {
        try {
            return await new Promise((resolve, reject) => {
                this.channel.on('data', (data) => {
                    if (!this.output.destroyed)
                        this.output.write(data);
                });
                this.channel.on('close', (code, signal) => {
                    this.topLevelExited = true;
                    this.output.end();
                    resolve({ exitCode: code, signal: normalizeSignal(signal) });
                });
                this.channel.on('error', (error) => {
                    this.output.destroy(error);
                    reject(error);
                });
            });
        }
        finally {
            this.topLevelExited = true;
        }
    }
    async closeOnce() {
        this.signal('TERM');
        await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)]);
        if (!this.topLevelExited)
            this.signal('KILL');
        await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)]);
        if (!this.topLevelExited)
            throw new Error(`subprocess-ssh: terminal cleanup failed; channel still open`);
    }
}
/**
 * Allocate an SSH PTY, replace its login shell with the requested argv, and
 * return the live terminal handle.
 * @param ssh - connection owner backing this execution world.
 * @param cwd - resolved absolute remote working directory.
 * @param spec - fully specified terminal-process request.
 * @returns the live terminal handle after allocation succeeds.
 */
export async function spawnSshTerminal(ssh, cwd, spec) {
    spec.signal?.throwIfAborted();
    const program = spec.argv[0];
    if (program === undefined || program.length === 0) {
        throw new Error('subprocess-ssh: terminal argv must contain a program');
    }
    const remote = await readRemoteEnvironment(ssh);
    const environment = serializeEnvironment(scrubRemoteEnvironment(remote), spec.env);
    const client = await ssh.getClient();
    spec.signal?.throwIfAborted();
    const channel = await new Promise((resolve, reject) => {
        client.shell({ term: 'xterm-256color', rows: spec.rows, cols: spec.cols }, (error, stream) => {
            if (error !== undefined)
                reject(error);
            else
                resolve(stream);
        });
    });
    const handle = new SshTerminalHandle(channel, spec.graceMs);
    const argv = spec.argv.map(quoteShellArg).join(' ');
    await handle.write(`cd ${quoteShellArg(cwd)} && exec env -i -- ${environment} ${argv}\r`);
    spec.signal?.throwIfAborted();
    return handle;
}
//# sourceMappingURL=terminal.js.map