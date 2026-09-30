/**
 * One standalone SSH connection owned by the connection registry (not the
 * `ctx.ssh` service): the same ProxyJump chain, auth, SFTP, and exec mechanics
 * as `SshRuntime`, but bound to a registry entry instead of the shared
 * service. The registry uses it for connection tests and per-connection
 * directory browsing; the `ssh://<id>/<path>` cwd routing in the providers
 * rides the same instances.
 * @module dsh-ssh/connection
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { Client } from 'ssh2';
import { wrapCwd, defaultIdentity } from "./runtime.js";
/** Read an identity value that is a local path to a PEM file (`~` expanded). */
function readIdentityFile(path) {
    const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
    return readFileSync(expanded, 'utf8');
}
/**
 * ssh2 failures carry transport `code`s (ECONNREFUSED, CLIENT_AUTH…) that host
 * services forward verbatim and their closed wire vocabularies then reject;
 * rewrap into a bare Error so consumers fall back to their own mapping. Abort
 * reasons and our own messages pass through untouched.
 */
function rewrapConnectError(error, label, endpoint) {
    if (!(error instanceof Error))
        return error;
    if (error.name === 'AbortError' || error.message.startsWith('dsh-ssh:'))
        return error;
    return new Error(`dsh-ssh: cannot connect to "${label}" (${endpoint}): ${error.message}`);
}
/** Build the ssh2 config for one hop, without the jump socket. */
function toConnectConfig(hop, agentFallback) {
    const config = {
        host: hop.host,
        port: hop.port,
        username: hop.username,
        readyTimeout: hop.readyTimeout,
        keepaliveInterval: hop.keepaliveInterval,
        keepaliveCountMax: hop.keepaliveCountMax,
    };
    if (hop.password !== undefined)
        config.password = hop.password;
    if (hop.privateKey !== undefined)
        config.privateKey = hop.privateKey;
    if (hop.passphrase !== undefined)
        config.passphrase = hop.passphrase;
    if (hop.agent !== undefined)
        config.agent = hop.agent;
    else if (agentFallback !== undefined)
        config.agent = agentFallback;
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
/** Host-key verifier accepting exactly the configured fingerprints/keys. */
function hostVerifierFor(knownHosts) {
    return (key) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
        const raw = key.toString('base64');
        return knownHosts.some((entry) => {
            const token = entry.trim().split(/\s+/).at(-1) ?? '';
            return token === fingerprint || token === raw;
        });
    };
}
/** A registry-owned live SSH connection (jump chain + shared SFTP). */
export class SshConnection {
    spec;
    id;
    label;
    endpoint;
    hops;
    strict;
    knownHosts;
    clients = [];
    ready;
    sftp;
    sftpOpening;
    remoteEnvironment;
    disposed = false;
    /** The transport's default remote working directory. */
    get cwd() {
        return this.spec.cwd ?? '/root';
    }
    /** Build the hop chain from a registry spec (auth defaults fall down the chain). */
    constructor(spec) {
        this.spec = spec;
        this.id = spec.id;
        this.label = spec.label;
        this.endpoint = `${spec.username}@${spec.host}`;
        this.strict = false;
        this.knownHosts = [];
        // Tailscale/DERP-relayed paths routinely exceed 20s to ready (observed
        // 4–20s variance); OpenSSH has no client-side handshake cap at all.
        const readyTimeout = spec.readyTimeout ?? 45_000;
        const keepaliveInterval = spec.keepaliveInterval ?? 0;
        const keepaliveCountMax = spec.keepaliveCountMax ?? 3;
        const parent = {
            host: spec.host,
            port: spec.port,
            username: spec.username,
            readyTimeout,
            keepaliveInterval,
            keepaliveCountMax,
        };
        if (spec.password !== undefined)
            parent.password = spec.password;
        if (spec.privateKeyPath !== undefined)
            parent.privateKey = readIdentityFile(spec.privateKeyPath);
        if (spec.passphrase !== undefined)
            parent.passphrase = spec.passphrase;
        if (spec.agent !== undefined)
            parent.agent = spec.agent;
        this.hops = [...(spec.jump ?? []).map((jump) => {
                const hop = {
                    host: jump.host ?? parent.host,
                    port: jump.port ?? parent.port,
                    username: jump.username ?? parent.username,
                    readyTimeout: jump.readyTimeout ?? readyTimeout,
                    keepaliveInterval: jump.keepaliveInterval ?? keepaliveInterval,
                    keepaliveCountMax: jump.keepaliveCountMax ?? keepaliveCountMax,
                };
                if (jump.password !== undefined)
                    hop.password = jump.password;
                if (jump.privateKey !== undefined)
                    hop.privateKey = jump.privateKey.includes('-----BEGIN') ? jump.privateKey : readIdentityFile(jump.privateKey);
                if (jump.passphrase !== undefined)
                    hop.passphrase = jump.passphrase;
                if (jump.agent !== undefined)
                    hop.agent = jump.agent;
                return hop;
            }), parent];
    }
    /** Release the chain and the shared SFTP channel. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.sftp !== undefined) {
            const sftp = this.sftp;
            this.sftp = undefined;
            try {
                sftp.end();
            }
            catch { /* already quiescent */ }
        }
        const clients = this.clients;
        this.clients = [];
        for (const client of clients.reverse()) {
            try {
                client.end();
            }
            catch { /* already quiescent */ }
        }
    }
    /**
     * Map a caller-supplied working directory onto this connection's host. The
     * rules mirror {@link SshRuntime.resolveRemoteCwd}: a POSIX absolute path is
     * already remote, while a Windows drive/UNC path or the absent cwd falls
     * back to the registry entry's configured remote cwd.
     */
    resolveRemoteCwd(cwd) {
        const fallback = this.cwd;
        if (cwd === undefined)
            return fallback;
        if (cwd.startsWith('ssh://')) {
            throw new Error('dsh-ssh: ssh:// working directories must be routed through ctx.subprocess or ctx.fs; ctx.ssh cannot choose a registry connection');
        }
        if (posix.isAbsolute(cwd))
            return cwd;
        if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\'))
            return fallback;
        return posix.resolve(fallback, cwd);
    }
    /** The authenticated target client after the jump chain succeeds. */
    async getClient(signal) {
        signal?.throwIfAborted();
        if (this.disposed)
            throw new Error(`dsh-ssh: connection "${this.label}" is disposed`);
        this.ready ??= this.open();
        let client;
        try {
            client = await this.ready;
        }
        catch (error) {
            throw rewrapConnectError(error, this.label, this.endpoint);
        }
        signal?.throwIfAborted();
        if (this.disposed)
            throw new Error(`dsh-ssh: connection "${this.label}" is disposed`);
        return client;
    }
    /** The shared SFTP channel, opened lazily once per connection. */
    async getSftp(signal) {
        if (this.disposed)
            throw new Error(`dsh-ssh: connection "${this.label}" is disposed`);
        if (this.sftp !== undefined)
            return this.sftp;
        this.sftpOpening ??= this.openSftp(signal);
        const sftp = await this.sftpOpening;
        if (this.sftp === undefined)
            this.sftp = sftp;
        return sftp;
    }
    /** The remote login environment, read once and cached. */
    getRemoteEnvironment(signal) {
        if (this.disposed)
            return Promise.reject(new Error(`dsh-ssh: connection "${this.label}" is disposed`));
        this.remoteEnvironment ??= this.readRemoteEnvironment(signal);
        return this.remoteEnvironment;
    }
    /** Run one control-plane command with collected output. */
    async exec(command, opts) {
        opts?.signal?.throwIfAborted();
        const client = await this.getClient(opts?.signal);
        const resolvedCwd = opts?.cwd !== undefined ? this.resolveRemoteCwd(opts.cwd) : undefined;
        const text = resolvedCwd !== undefined ? wrapCwd(resolvedCwd, command) : command;
        const outcome = await new Promise((resolve, reject) => {
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
            const onAbort = () => { channel?.close(); };
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
    async openSftp(signal) {
        const client = await this.getClient(signal);
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
    async readRemoteEnvironment(signal) {
        const { exitCode, stdout } = await this.exec('env -0', signal === undefined ? undefined : { signal });
        if (exitCode !== 0)
            throw new Error(`dsh-ssh: cannot read the remote environment of "${this.label}"`);
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
    async open() {
        const clients = [];
        try {
            for (let index = 0; index < this.hops.length; index += 1) {
                const hop = this.hops[index];
                const previous = clients[index - 1];
                const client = new Client();
                clients.push(client);
                const config = toConnectConfig(hop, undefined);
                if (this.strict)
                    config.hostVerifier = hostVerifierFor(this.knownHosts);
                if (previous === undefined) {
                    await connectReady(client, config);
                }
                else {
                    const socket = await forwardThrough(previous, hop.host, hop.port);
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
                catch { /* best effort */ }
            }
            throw error;
        }
    }
}
//# sourceMappingURL=connection.js.map