/**
 * Shared ownership of one SSH execution world. Capability adapters await the same
 * authenticated connection (reached through an optional ProxyJump chain), so
 * filesystem and process operations inhabit one remote host. Auth, keepalive,
 * host-key verification, and the jump chain mirror the portable subset of an
 * OpenSSH `~/.ssh/config` `Host` block.
 * @module @deepseek-ai/dsh-ssh
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { Client } from 'ssh2';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/**
 * Quote one argument for a POSIX login shell: single quotes with the only
 * escaping a single-quoted string needs. Identical in spirit to the E2B
 * adapter's helper so both remote providers share one quoting rule.
 * @param value - exact argument value to preserve.
 * @returns a single shell word with no interpolation.
 */
export function quoteShellArg(value) {
    return `'${value.replaceAll('\'', '\'"\'"\'')}'`;
}
/**
 * Wrap a remote command so it runs from the configured working directory.
 * @param cwd - absolute remote working directory.
 * @param command - the remote command to run there.
 * @returns the `cd`-guarded command text.
 */
export function wrapCwd(cwd, command) {
    return `cd -- ${quoteShellArg(cwd)} && ${command}`;
}
/** Reads an identity value that is either PEM content or a local identity-file path. */
function resolvePrivateKey(value) {
    return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}
/**
 * Build the host-key verifier for strict checking: accept only a key whose
 * SHA256 fingerprint or raw base64 encoding matches a known-hosts entry.
 * @param knownHosts - configured trusted fingerprints or keys.
 * @returns a verifier accepting exactly the matching keys.
 */
function hostVerifierFor(knownHosts) {
    return (key) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
        const raw = key.toString('base64');
        return knownHosts.some((entry) => {
            // A known_hosts line is "<host> <keytype> <token>"; the token is the field that varies.
            const token = entry.trim().split(/\s+/).at(-1) ?? '';
            return token === fingerprint || token === raw;
        });
    };
}
/** OpenSSH's default identity probe order, used when no auth is configured. */
const DEFAULT_IDENTITY_FILES = ['.ssh/id_ed25519', '.ssh/id_ecdsa', '.ssh/id_rsa'];
/**
 * The first existing OpenSSH default identity, mirroring the ssh client's own
 * probe: a hop with no password, key, or agent configured would otherwise be
 * rejected by every server because ssh2 never tries default key files.
 */
export function defaultIdentity() {
    for (const candidate of DEFAULT_IDENTITY_FILES) {
        const expanded = join(homedir(), candidate);
        if (existsSync(expanded))
            return readFileSync(expanded, 'utf8');
    }
    return undefined;
}
/** Resolve auth and defaults into one connection hop. */
function resolveHost(config) {
    const host = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.readyTimeout,
        keepaliveInterval: config.keepaliveInterval,
        keepaliveCountMax: config.keepaliveCountMax,
    };
    if (config.password !== undefined)
        host.password = config.password;
    if (config.privateKey !== undefined)
        host.privateKey = resolvePrivateKey(config.privateKey);
    if (config.passphrase !== undefined)
        host.passphrase = config.passphrase;
    if (config.agent !== undefined)
        host.agent = config.agent;
    return host;
}
/** Resolve one jump hop with auth and defaults falling back to the parent. */
function resolveJump(jump, parent) {
    const host = {
        host: jump.host ?? parent.host,
        port: jump.port ?? parent.port,
        username: jump.username ?? parent.username,
        readyTimeout: jump.readyTimeout ?? parent.readyTimeout,
        keepaliveInterval: jump.keepaliveInterval ?? parent.keepaliveInterval,
        keepaliveCountMax: jump.keepaliveCountMax ?? parent.keepaliveCountMax,
    };
    if (jump.password !== undefined)
        host.password = jump.password;
    if (jump.privateKey !== undefined)
        host.privateKey = resolvePrivateKey(jump.privateKey);
    if (jump.passphrase !== undefined)
        host.passphrase = jump.passphrase;
    if (jump.agent !== undefined)
        host.agent = jump.agent;
    return host;
}
/** Shape the ssh2 connection config for one hop, without the jump socket. */
function toConnectConfig(host, strict, knownHosts) {
    const config = {
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: host.readyTimeout,
        keepaliveInterval: host.keepaliveInterval,
        keepaliveCountMax: host.keepaliveCountMax,
    };
    if (host.password !== undefined)
        config.password = host.password;
    if (host.privateKey !== undefined)
        config.privateKey = host.privateKey;
    if (host.passphrase !== undefined)
        config.passphrase = host.passphrase;
    if (host.agent !== undefined)
        config.agent = host.agent;
    if (strict)
        config.hostVerifier = hostVerifierFor(knownHosts);
    if (config.password === undefined && config.privateKey === undefined && config.agent === undefined) {
        const identity = defaultIdentity();
        if (identity !== undefined)
            config.privateKey = identity;
    }
    return config;
}
/** Resolve once the client reaches its ready state. */
function connectReady(client, config) {
    return new Promise((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const cleanup = () => {
            client.removeListener('ready', onReady);
            client.removeListener('error', onError);
        };
        client.once('ready', onReady);
        client.once('error', onError);
        client.connect(config);
    });
}
/** Open a direct-tcpip channel through one already-connected hop. */
function forwardThrough(client, host, port) {
    return new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
            if (error !== undefined)
                reject(error);
            else
                resolve(channel);
        });
    });
}
/** SSH connection owner registered as `ctx.ssh`. */
export class SshRuntime extends Service {
    static Config = z.object({
        host: z.string().required(),
        port: z.number().default(22),
        username: z.string().required(),
        password: z.string(),
        privateKey: z.string(),
        passphrase: z.string(),
        agent: z.string(),
        jump: z.array(z.object({
            host: z.string().required(),
            port: z.number(),
            username: z.string(),
            password: z.string(),
            privateKey: z.string(),
            passphrase: z.string(),
            agent: z.string(),
            readyTimeout: z.number(),
            keepaliveInterval: z.number(),
            keepaliveCountMax: z.number(),
        })).default([]),
        cwd: z.string().required(),
        readyTimeout: z.number().default(45_000),
        keepaliveInterval: z.number().default(0),
        keepaliveCountMax: z.number().default(3),
        strictHostKeyChecking: z.boolean().default(false),
        knownHosts: z.array(z.string()).default([]),
    });
    /** Validated remote working directory shared by provider adapters. */
    cwd;
    /** Human-readable connection target for UI surfaces (`username@host`). */
    endpoint;
    config;
    hosts;
    clients = [];
    ready;
    sftp;
    sftpOpening;
    remoteEnvironment;
    disposed = false;
    /** Validate config, resolve the jump chain, and bind the disposal policy. */
    constructor(ctx, config) {
        super(ctx, 'ssh');
        const resolved = config;
        this.validate(resolved);
        this.config = resolved;
        this.cwd = resolved.cwd;
        this.endpoint = `${resolved.username}@${resolved.host}`;
        this.hosts = [...resolved.jump.map(jump => resolveJump(jump, resolved)), resolveHost(resolved)];
        ctx.effect(() => async () => {
            this.disposed = true;
            if (this.sftp !== undefined) {
                const sftp = this.sftp;
                this.sftp = undefined;
                try {
                    sftp.end();
                }
                catch (_alreadyEnded) {
                    // A closed SFTP channel is already quiescent.
                }
            }
            const clients = this.clients;
            this.clients = [];
            // End the target first so its channel closes before the jump sockets it rode.
            for (const client of clients.reverse()) {
                try {
                    client.end();
                }
                catch (_alreadyEnded) {
                    // A client that already ended is already quiescent.
                }
            }
        }, 'ssh teardown');
    }
    /**
     * Return the shared live connection after the jump chain and auth succeed.
     * @returns the authenticated target client.
     * @throws when connection, jump, or authentication fails, or when disposing.
     */
    async getClient() {
        if (this.disposed)
            throw new Error('SSH service is disposing');
        this.ready ??= this.open();
        const client = await this.ready;
        if (this.disposed)
            throw new Error('SSH service is disposing');
        return client;
    }
    /**
     * Return the shared SFTP channel, opened lazily once per connection. A
     * closed connection invalidates it so the next call reopens.
     * @returns the live SFTP wrapper.
     */
    async getSftp() {
        if (this.disposed)
            throw new Error('SSH service is disposing');
        if (this.sftp !== undefined)
            return this.sftp;
        this.sftpOpening ??= this.openSftp();
        const sftp = await this.sftpOpening;
        if (this.sftp === undefined)
            this.sftp = sftp;
        return sftp;
    }
    async openSftp() {
        const client = await this.getClient();
        const sftp = await new Promise((resolve, reject) => {
            client.sftp((error, value) => {
                if (error !== undefined)
                    reject(error);
                else
                    resolve(value);
            });
        });
        const invalidate = () => {
            this.sftp = undefined;
            this.sftpOpening = undefined;
        };
        sftp.on('close', invalidate);
        sftp.on('end', invalidate);
        return sftp;
    }
    /**
     * Return the remote login environment, read once per connection and cached.
     * The login environment is stable for the connection lifetime, so adapters
     * avoid one control command per spawned process.
     * @returns the remote environment as name/value entries.
     */
    getRemoteEnvironment() {
        if (this.disposed)
            return Promise.reject(new Error('SSH service is disposing'));
        this.remoteEnvironment ??= this.readRemoteEnvironment();
        return this.remoteEnvironment;
    }
    async readRemoteEnvironment() {
        const { exitCode, stdout } = await this.exec('env -0');
        if (exitCode !== 0)
            throw new Error('dsh-ssh: cannot read the remote environment');
        const environment = {};
        for (const entry of stdout.split('\0')) {
            if (entry.length === 0)
                continue;
            const separator = entry.indexOf('=');
            if (separator <= 0)
                continue;
            environment[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
        return environment;
    }
    /**
     * Map a caller-supplied working directory onto the remote host. The harness
     * hands providers the session cwd, which is a local path when the harness
     * runs on the developer machine; a local absolute path (Windows drive, UNC)
     * or a relative path has no meaning on the remote host, so it is redirected
     * to the configured remote cwd. A POSIX absolute path is a remote path and
     * passes through unchanged.
     * @param cwd - the caller-supplied working directory, or `undefined` for the default.
     * @returns the remote working directory to execute in.
     */
    resolveRemoteCwd(cwd) {
        if (cwd === undefined)
            return this.cwd;
        if (cwd.startsWith('ssh://')) {
            throw new Error('dsh-ssh: ssh:// working directories must be routed through ctx.subprocess or ctx.fs; ctx.ssh cannot choose a registry connection');
        }
        if (posix.isAbsolute(cwd))
            return cwd;
        if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\'))
            return this.cwd;
        return posix.resolve(this.cwd, cwd);
    }
    /**
     * Run one control-plane command with collected output. Used by adapters for
     * executable lookup and canonical-path resolution, not for user work.
     * @param command - remote command text (already shell-quoted by the caller).
     * @param opts - optional working-directory override and cancellation.
     * @returns the collected exit facts and output.
     */
    async exec(command, opts) {
        opts?.signal?.throwIfAborted();
        const client = await this.getClient();
        const resolvedCwd = opts?.cwd !== undefined ? this.resolveRemoteCwd(opts.cwd) : undefined;
        const text = resolvedCwd !== undefined ? wrapCwd(resolvedCwd, command) : command;
        const outcome = await new Promise((resolve, reject) => {
            // Buffer whole chunks and decode once: SSH data events may split a
            // multi-byte UTF-8 character across two callbacks, so per-chunk
            // decoding would corrupt it.
            const stdoutChunks = [];
            const stderrChunks = [];
            let settled = false;
            let channel;
            const finish = (exitCode, signal) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve({
                    exitCode,
                    signal,
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: Buffer.concat(stderrChunks).toString('utf8'),
                });
            };
            const onAbort = () => {
                // Closing the channel ends the remote command; its close event reports the outcome.
                channel?.close();
            };
            const cleanup = () => { opts?.signal?.removeEventListener('abort', onAbort); };
            client.exec(text, { pty: false }, (error, stream) => {
                if (error !== undefined) {
                    cleanup();
                    reject(error);
                    return;
                }
                channel = stream;
                stream.on('data', (data) => { stdoutChunks.push(data); });
                stream.stderr.on('data', (data) => { stderrChunks.push(data); });
                stream.on('close', (code, signal) => { finish(code, signal); });
            });
            if (opts?.signal?.aborted === true) {
                onAbort();
                return;
            }
            opts?.signal?.addEventListener('abort', onAbort, { once: true });
        });
        opts?.signal?.throwIfAborted();
        return outcome;
    }
    validate(config) {
        if (config.host.trim().length === 0)
            throw new Error('dsh-ssh: host must be a non-empty string');
        if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
            throw new Error(`dsh-ssh: port must be an integer in 1..65535: ${config.port}`);
        }
        if (config.username.trim().length === 0)
            throw new Error('dsh-ssh: username must be a non-empty string');
        if (!posix.isAbsolute(config.cwd))
            throw new Error(`dsh-ssh: cwd must be an absolute POSIX path: ${config.cwd}`);
        for (const [index, jump] of config.jump.entries()) {
            if ((jump.host ?? '').trim().length === 0)
                throw new Error(`dsh-ssh: jump[${index}].host must be a non-empty string`);
        }
    }
    async open() {
        const clients = [];
        try {
            for (let index = 0; index < this.hosts.length; index += 1) {
                const host = this.hosts[index];
                const previous = clients[index - 1];
                const client = new Client();
                clients.push(client);
                const config = toConnectConfig(host, this.config.strictHostKeyChecking, this.config.knownHosts);
                if (previous === undefined) {
                    await connectReady(client, config);
                }
                else {
                    const socket = await forwardThrough(previous, host.host, host.port);
                    await connectReady(client, { ...config, sock: socket });
                }
            }
            this.clients = clients;
            return clients[clients.length - 1];
        }
        catch (error) {
            for (const client of clients.reverse()) {
                try {
                    client.end();
                }
                catch (_alreadyEnded) {
                    // Best-effort teardown of the partial chain; the original error owns the failure.
                }
            }
            throw error;
        }
    }
}
export default SshRuntime;
//# sourceMappingURL=runtime.js.map