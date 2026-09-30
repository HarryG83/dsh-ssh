/**
 * Web-facing RPC channel of dsh-ssh: mounts the connection registry and
 * registers the `/dsh-ssh` unary channel directly on the web server, speaking
 * the Connection client-request/server-response envelope behind the host's
 * Host/Origin fence and browser authentication. The client half drives
 * connection management and remote directory browsing through it; endpoints
 * are plain JSON.
 * @module dsh-ssh/web
 */
import { mkdir, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { pickNativeDirectory } from '@deepseek-ai/dsh-host-directory-picker-native';
import SshRegistry from "./registry.js";
import { sshRoutePlaceholder } from "./transport.js";
/** Required host service: the web transport that carries the RPC channel. */
export const inject = ['connection'];
/** Validated channel config. */
export const Config = z.object({
    stateFile: z.string(),
    maxEntries: z.number().min(1).default(1000),
});
/** Message text of an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Await a value, failing with a `bad-request` error when the guard rejects. */
function requirePayload(payload, guard, what) {
    if (!guard(payload)) {
        throw new Error(`bad-request: ${what} payload is invalid`);
    }
    return payload;
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
/** `ssh://<id>` route payload. */
function isIdPayload(value) {
    return isRecord(value) && isString(value.id) && value.id.trim() !== '';
}
/** Browse payload: `{ id, path? }`. */
function isBrowsePayload(value) {
    return isRecord(value) && isString(value.id) && value.id.trim() !== ''
        && (value.path === undefined || isString(value.path));
}
/** Session-route payload: `{ id, path }` with an absolute POSIX remote path. */
function isSessionRoutePayload(value) {
    return isRecord(value) && isString(value.id) && value.id.trim() !== ''
        && isString(value.path) && posix.isAbsolute(value.path);
}
/** Connection input payload (subset keys, all strings/numbers/arrays). */
function isConnectionInput(value) {
    if (!isRecord(value))
        return false;
    if (!isString(value.host) || value.host.trim() === '')
        return false;
    for (const key of ['label', 'username', 'password', 'privateKeyPath', 'passphrase', 'agent', 'cwd']) {
        const field = value[key];
        if (field !== undefined && !isString(field))
            return false;
    }
    if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isInteger(value.port)))
        return false;
    if (value.jump !== undefined) {
        if (!Array.isArray(value.jump))
            return false;
        for (const hop of value.jump) {
            if (!isRecord(hop) || !isString(hop.host) || hop.host.trim() === '')
                return false;
            if (hop.port !== undefined && (typeof hop.port !== 'number' || !Number.isInteger(hop.port)))
                return false;
            for (const key of ['username', 'privateKeyPath', 'agent']) {
                if (hop[key] !== undefined && !isString(hop[key]))
                    return false;
            }
        }
    }
    return true;
}
/**
 * Map a channel failure onto the HOST's closed rpc error vocabulary — the
 * client transport validates `code` against its discriminated union and
 * per-code `details` shapes, so an off-vocabulary code surfaces as a raw zod
 * dump instead of the business message.
 */
const wireError = (code, message) => {
    if (code === 'bad-request') {
        return { ok: false, error: { code, message, details: { issues: [] } } };
    }
    return { ok: false, error: { code: 'internal', message, details: {} } };
};
/** The dedicated unary RPC channel this module owns. */
const CHANNEL_PATH = '/dsh-ssh';
/** One endpoint segment, mirroring the Connection RPC host's alphabet. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** Correlation id used when a malformed envelope carries no usable rpcId. */
const INVALID_REQUEST_RPC_ID = 'invalid-request';
/** Body cap for this JSON-only channel; the core default (300 MiB) guards attachments. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Resolve the endpoint one channel path names, or undefined when it names none. */
function endpointFromPath(pathname) {
    if (!pathname.startsWith(`${CHANNEL_PATH}/`)) {
        return undefined;
    }
    const endpoint = pathname.slice(CHANNEL_PATH.length + 1);
    const segments = endpoint.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        return undefined;
    }
    return endpoint;
}
/** Write one plain-text response. */
function sendText(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
}
/** Write one JSON response — the envelope the client transport parses. */
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
/** One failure envelope in the host's closed RPC error vocabulary. */
function failureEnvelope(rpcId, error) {
    return { type: 'server-response', rpcId, result: { ok: false, error } };
}
/**
 * Buffer one request body, answering 413 for an oversized payload. Resolves
 * undefined once a response has already been written.
 */
function readBody(req, res) {
    return new Promise((resolvePromise) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const settle = (value) => {
            if (!settled) {
                settled = true;
                resolvePromise(value);
            }
        };
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            sendText(res, 413, 'payload too large');
            req.resume();
            settle(undefined);
            return;
        }
        req.on('data', (chunk) => {
            if (settled) {
                return;
            }
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                sendText(res, 413, 'payload too large');
                settle(undefined);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => {
            sendText(res, 400, 'body is not readable');
            settle(undefined);
        });
    });
}
/**
 * Serve one `/dsh-ssh` request in the Connection RPC envelope: the Host/Origin
 * fence and browser authentication come from `connection.admit`, then the
 * endpoint runs with a request-scoped abort signal and its result is wrapped
 * in a `server-response` envelope.
 */
async function handleChannelRequest(connection, dispatch, req, res) {
    const admission = connection.admit(req);
    if (admission.rejection !== undefined) {
        sendText(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
    }
    const endpoint = endpointFromPath(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (req.method !== 'POST' || endpoint === undefined) {
        sendText(res, 404, 'not found');
        return;
    }
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
        sendText(res, 415, 'content type must be application/json');
        return;
    }
    const body = await readBody(req, res);
    if (body === undefined) {
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        sendText(res, 400, 'body is not JSON');
        return;
    }
    const rpcId = isRecord(parsed) && isString(parsed.rpcId) ? parsed.rpcId : undefined;
    if (!isRecord(parsed) || parsed.type !== 'client-request' || rpcId === undefined || !isString(parsed.method)) {
        sendJson(res, 200, failureEnvelope(rpcId ?? INVALID_REQUEST_RPC_ID, {
            code: 'gateway/bad-request',
            message: 'invalid client-request message',
            details: { issues: [] },
        }));
        return;
    }
    if (parsed.method !== endpoint) {
        sendJson(res, 200, failureEnvelope(rpcId, {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(parsed.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
        }));
        return;
    }
    const controller = new AbortController();
    const abortIfPending = () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    };
    req.once('aborted', abortIfPending);
    res.once('close', abortIfPending);
    try {
        const result = await dispatch(endpoint, parsed.payload, controller.signal);
        if (!res.writableEnded && !res.destroyed) {
            sendJson(res, 200, { type: 'server-response', rpcId, result });
        }
    }
    catch (error) {
        if (!res.writableEnded && !res.destroyed) {
            sendText(res, 500, `handler failure: ${String(error)}`);
        }
    }
}
/** Ancestor chain from the remote root to `target` inclusive. */
function ancestryCrumbs(target) {
    const crumbs = [];
    let current = target;
    for (;;) {
        const parent = posix.dirname(current);
        crumbs.unshift({ name: parent === current ? current : posix.basename(current), path: current, hidden: false });
        if (parent === current)
            return crumbs;
        current = parent;
    }
}
/**
 * Mount the connection registry and the `/dsh-ssh` channel.
 * @param ctx - the mounting Cordis context.
 * @param config - state file and listing bound.
 */
export function apply(ctx, config) {
    ctx.plugin(SshRegistry, { ...(config.stateFile !== undefined ? { stateFile: config.stateFile } : {}) });
    const maxEntries = config.maxEntries ?? 1000;
    const registry = () => {
        const value = ctx.get('sshRegistry');
        if (value === undefined)
            throw new Error('dsh-ssh: the connection registry is not mounted');
        return value;
    };
    const requireConnection = (id) => {
        const connection = registry().get(id);
        if (connection === undefined)
            throw new Error(`dsh-ssh: unknown connection id ${JSON.stringify(id)}`);
        return connection;
    };
    /** The remote home directory: the login environment's HOME, else the spec cwd. */
    const remoteHome = async (id, signal) => {
        const connection = requireConnection(id);
        try {
            const environment = await connection.getRemoteEnvironment(signal);
            const home = environment.HOME;
            if (isString(home) && home.trim() !== '')
                return home;
        }
        catch {
            // A dead connection falls back below; the listing itself still surfaces it.
        }
        return connection.spec.cwd ?? '/root';
    };
    /** List one remote level over the connection's shared SFTP channel. */
    const listRemote = async (id, target, signal) => {
        const connection = requireConnection(id);
        const resolvedTarget = target ?? await remoteHome(id, signal);
        if (!posix.isAbsolute(resolvedTarget)) {
            throw new Error(`dsh-ssh: cannot list ${resolvedTarget}: not a fully qualified path`);
        }
        const home = await remoteHome(id, signal);
        const sftp = await connection.getSftp(signal);
        const listed = await new Promise((resolvePromise, reject) => {
            sftp.readdir(resolvedTarget, (error, entries) => {
                if (error !== undefined)
                    reject(error);
                else
                    resolvePromise(entries);
            });
        });
        const entries = [];
        let truncated = false;
        for (const entry of listed) {
            signal?.throwIfAborted();
            const candidate = entry.filename;
            if (!entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink())
                continue;
            let enterable = entry.attrs.isDirectory();
            if (!enterable) {
                try {
                    const stats = await new Promise((resolvePromise, reject) => {
                        sftp.stat(posix.join(resolvedTarget, candidate), (error, value) => {
                            if (error !== undefined)
                                reject(error);
                            else
                                resolvePromise(value);
                        });
                    });
                    enterable = stats.isDirectory();
                }
                catch {
                    if (signal?.aborted === true)
                        throw signal.reason;
                    continue;
                }
            }
            if (!enterable)
                continue;
            if (entries.length === maxEntries) {
                truncated = true;
                break;
            }
            entries.push({ name: candidate, path: posix.join(resolvedTarget, candidate), hidden: candidate.startsWith('.') });
        }
        return {
            path: resolvedTarget,
            home,
            crumbs: ancestryCrumbs(resolvedTarget),
            entries,
            truncated,
        };
    };
    /** Create one child directory on the remote host (SFTP mkdir, non-recursive). */
    const createRemoteDirectory = async (id, path, name, signal) => {
        if (!posix.isAbsolute(path))
            throw new Error(`dsh-ssh: cannot create under ${JSON.stringify(path)}: not a fully qualified path`);
        if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
            throw new Error(`dsh-ssh: ${JSON.stringify(name)} is not a single path segment`);
        }
        const target = posix.join(path, name);
        const connection = requireConnection(id);
        const sftp = await connection.getSftp(signal);
        const existing = await new Promise((resolvePromise) => {
            sftp.lstat(target, (error, value) => { resolvePromise(error === undefined ? value : undefined); });
        });
        if (existing !== undefined)
            throw new Error(`dsh-ssh: ${target} already exists`);
        await new Promise((resolvePromise, reject) => {
            sftp.mkdir(target, (error) => { if (error !== undefined)
                reject(error);
            else
                resolvePromise(); });
        });
        return target;
    };
    const dispatch = async (endpoint, payload, signal) => {
        try {
            switch (endpoint) {
                case 'connections.list': return { ok: true, value: registry().list() };
                case 'config.hosts': {
                    // Re-reads ~/.ssh/config on every call; wildcards stay hidden.
                    return { ok: true, value: registry().listConfigHosts() };
                }
                case 'connections.resolve': {
                    const input = requirePayload(payload, isRecord, 'connections.resolve');
                    const host = input.host;
                    if (!isString(host) || host.trim() === '')
                        throw new Error('bad-request: host must be a non-empty string');
                    const resolved = registry().resolveSshConfig(host.trim());
                    return { ok: true, value: { ...resolved, alias: host.trim() } };
                }
                case 'connections.add': {
                    const input = requirePayload(payload, isConnectionInput, 'connections.add');
                    const added = registry().add(input);
                    return { ok: true, value: added };
                }
                case 'connections.remove': {
                    const input = requirePayload(payload, isIdPayload, 'connections.remove');
                    const removed = registry().remove(input.id.trim());
                    if (removed) {
                        // Drop the connection's local route placeholders; stale ones would
                        // route to a dead registry id on the next session resume.
                        void rm(sshRoutePlaceholder(input.id.trim(), '/'), { recursive: true, force: true })
                            .catch(() => undefined);
                    }
                    return { ok: true, value: { removed } };
                }
                case 'connections.test': {
                    const input = requirePayload(payload, isConnectionInput, 'connections.test');
                    const outcome = await registry().test(input);
                    return outcome.ok ? { ok: true, value: { ok: true } } : wireError('connection-failed', outcome.message);
                }
                case 'browse.home': {
                    const input = requirePayload(payload, isIdPayload, 'browse.home');
                    return { ok: true, value: { path: await remoteHome(input.id.trim(), signal) } };
                }
                case 'browse.list': {
                    const input = requirePayload(payload, isBrowsePayload, 'browse.list');
                    return { ok: true, value: await listRemote(input.id.trim(), input.path, signal) };
                }
                case 'browse.mkdir': {
                    const input = requirePayload(payload, isRecord, 'browse.mkdir');
                    if (!isString(input.id) || !isString(input.path) || !isString(input.name)) {
                        throw new Error('bad-request: browse.mkdir needs id, path, and name');
                    }
                    const created = await createRemoteDirectory(input.id.trim(), input.path, input.name, signal);
                    return { ok: true, value: { path: created } };
                }
                case 'session.route': {
                    // The host's session service `mkdir`s the project directory through
                    // `node:fs`, so an `ssh://` cwd can never pass; hand the client a
                    // LOCAL placeholder instead, which both sides translate back into
                    // the registry route (see transport.ts).
                    const input = requirePayload(payload, isSessionRoutePayload, 'session.route');
                    requireConnection(input.id.trim());
                    const placeholder = sshRoutePlaceholder(input.id.trim(), input.path);
                    await mkdir(placeholder, { recursive: true });
                    return { ok: true, value: { cwd: placeholder } };
                }
                case 'local.pickNative': {
                    // One OS folder chooser on the host display — faster than walking
                    // the browse list for local workspaces. Null means the operator
                    // cancelled.
                    const path = await pickNativeDirectory(signal);
                    return { ok: true, value: { path } };
                }
                default:
                    throw new Error(`bad-request: unknown endpoint ${JSON.stringify(endpoint)}`);
            }
        }
        catch (error) {
            const message = messageOf(error);
            const code = message.startsWith('bad-request:') ? 'bad-request' : 'connection-failed';
            return wireError(code, message.replace(/^bad-request: /u, ''));
        }
    };
    // Register the channel directly on the web server. dsh 0.2.0-rc.2's
    // `connection.rpc.handle()` resolves `webServer` through the connection
    // service's own shadowed context instead of the caller's, so every
    // non-core caller throws `cannot get property "webServer" without inject`
    // and the channel never registers. This route speaks the same
    // client-request/server-response envelope while the Host/Origin fence and
    // browser authentication still come from admitting through `connection`.
    ctx.inject(['webServer'], (webCtx) => {
        const route = {
            kind: 'prefix',
            path: CHANNEL_PATH,
            handler: (req, res) => handleChannelRequest(webCtx.connection, dispatch, req, res),
        };
        webCtx.effect(() => webCtx.webServer.register(route), 'dsh-ssh: /dsh-ssh rpc channel');
    });
}
//# sourceMappingURL=web.js.map