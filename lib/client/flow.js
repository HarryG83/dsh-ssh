import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The add-workspace directory flow of dsh-ssh, laid out as a connection
 * sidebar beside a directory browser (VS Code Remote Explorer style): the
 * sidebar lists `~/.ssh/config` hosts (one click resolves, registers, and
 * browses — no form), saved connections, and the local entry; the right pane
 * browses whichever side is active. Picking a remote directory hands the owner
 * an `ssh://<id><path>` workspace path, which the deployment's remote
 * providers consume (see README for the workspace-adoption seam).
 */
import { useEffect, useRef, useState } from 'react';
import { ConnectionForm } from "./form.js";
import { cx, useDialogA11y } from "./ui.js";
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon, EyeIcon, FolderIcon, FolderPlusIcon, HomeIcon, KeyIcon, LockIcon, MonitorIcon, PlusIcon, RefreshIcon, RouteIcon, ServerIcon, SpinnerIcon, TrashIcon, } from "./icons.js";
import styles from './flow.module.css';
const EMPTY_PANE = { path: null, listing: null, error: null, loading: false };
/** Unwrap a wire result or throw its business error. */
function unwrap(result, fallback) {
    if (!result.ok)
        throw new Error(result.error.message || fallback);
    return result.value;
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Minimal structural check for a wire listing. */
function asListing(value) {
    const record = isRecord(value) ? value : {};
    const wireEntry = (entry) => ({
        name: String(entry?.name ?? ''),
        path: String(entry?.path ?? ''),
        hidden: entry?.hidden === true,
    });
    return {
        path: typeof record.path === 'string' ? record.path : '',
        home: typeof record.home === 'string' ? record.home : '',
        crumbs: Array.isArray(record.crumbs) ? record.crumbs.filter(isRecord).map(wireEntry) : [],
        entries: Array.isArray(record.entries) ? record.entries.filter(isRecord).map(wireEntry) : [],
        truncated: record.truncated === true,
    };
}
/** Structural check for one `config.hosts` row. */
function asConfigHosts(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter(isRecord).map(record => ({
        alias: String(record.alias ?? ''),
        host: String(record.host ?? ''),
        username: String(record.username ?? ''),
        port: typeof record.port === 'number' ? record.port : 22,
        identityFile: record.identityFile === true,
        jump: record.jump === true,
    })).filter(host => host.alias !== '');
}
/** Structural check for one secret-free connection view. */
function asConnectionView(record) {
    return {
        id: String(record.id ?? ''),
        label: String(record.label ?? ''),
        host: String(record.host ?? ''),
        port: typeof record.port === 'number' ? record.port : 22,
        username: String(record.username ?? ''),
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        auth: (record.auth === 'password' || record.auth === 'agent' ? record.auth : 'key'),
        jumpHosts: Array.isArray(record.jumpHosts) ? record.jumpHosts.map(String) : [],
    };
}
/** Structural check for a `connections.resolve` result. */
function asResolved(value) {
    const record = isRecord(value) ? value : {};
    return {
        host: typeof record.host === 'string' ? record.host : '',
        username: typeof record.username === 'string' ? record.username : '',
        port: typeof record.port === 'number' ? record.port : 22,
        privateKeyPaths: Array.isArray(record.privateKeyPaths) ? record.privateKeyPaths.map(String) : [],
        jump: Array.isArray(record.jump) ? record.jump.filter(isRecord).map(hop => ({
            host: String(hop.host ?? ''),
            ...(typeof hop.port === 'number' ? { port: hop.port } : {}),
            ...(typeof hop.username === 'string' && hop.username !== '' ? { username: hop.username } : {}),
            ...(hop.privateKeyPath !== undefined ? { privateKeyPath: String(hop.privateKeyPath) } : {}),
        })) : [],
        alias: typeof record.alias === 'string' ? record.alias : '',
    };
}
/** Structural check for a `connections.add` result (its view only). */
function asAddedView(value) {
    const record = isRecord(value) ? value : {};
    return asConnectionView(isRecord(record.view) ? record.view : {});
}
/**
 * Translate a raw ssh2/web error into a readable remote failure. ssh2 never
 * consults the OS agent or default identities on its own, so a spec without
 * password/privateKey/agent surfaces as `All configured authentication
 * methods failed` — that one gets the auth-completion guidance.
 */
function describeRemoteFailure(raw) {
    if (/invalid_union/.test(raw)) {
        return {
            title: '无法创建远程会话',
            text: '宿主返回了无法解析的错误响应——最常见的原因是 SSH 连接失败。请检查该主机的认证与网络配置后重试。',
            needsAuth: false,
        };
    }
    if (/all configured authentication methods/i.test(raw)) {
        return {
            title: '认证失败',
            text: '该主机没有可用的私钥或密码，SSH 服务器拒绝了登录。可点击「补全认证」，在表单中填写认证信息后重试。',
            needsAuth: true,
        };
    }
    if (/cannot parse privatekey|cannot read private key|invalid private key|no key found/i.test(raw)) {
        return {
            title: '私钥不可用',
            text: `无法读取或解析私钥文件，请检查路径、口令与文件权限。原始错误：${raw}`,
            needsAuth: true,
        };
    }
    if (/timed?\s?out|etimedout/i.test(raw)) {
        return { title: '连接超时', text: '在超时前未能建立连接，请检查主机名、端口与网络可达性。', needsAuth: false };
    }
    if (/econnrefused/i.test(raw)) {
        return { title: '连接被拒绝', text: '目标端口未开放或拒绝了连接，请核对端口。', needsAuth: false };
    }
    if (/enotfound|getaddrinfo|dns/i.test(raw)) {
        return { title: '找不到主机', text: '域名解析失败，请核对主机名或修正 ~/.ssh/config 中的 HostName。', needsAuth: false };
    }
    if (/ehostunreach|enetunreach/i.test(raw)) {
        return { title: '网络不可达', text: '本机无法路由到该主机，请检查网络或跳板配置。', needsAuth: false };
    }
    return { title: '无法连接远程主机', text: raw, needsAuth: false };
}
/** The directory-flow occupant registered into both workspace holes. */
export function SshWorkspaceFlow(props) {
    const { open, busy, onPicked, onCancel, listLocalDirectory, createLocalDirectory, rpc } = props;
    const [mode, setMode] = useState({ kind: 'local' });
    const [pane, setPane] = useState(EMPTY_PANE);
    const [connections, setConnections] = useState([]);
    const [connectionsLoading, setConnectionsLoading] = useState(false);
    const [connectionsError, setConnectionsError] = useState(null);
    const [configHosts, setConfigHosts] = useState([]);
    const [configLoading, setConfigLoading] = useState(false);
    const [configError, setConfigError] = useState(null);
    const [hostPending, setHostPending] = useState(null);
    const [hostError, setHostError] = useState(null);
    const [confirmTarget, setConfirmTarget] = useState(null);
    const [formOpen, setFormOpen] = useState(false);
    const [formDraft, setFormDraft] = useState(undefined);
    const [folderDraft, setFolderDraft] = useState(null);
    const [openingRemote, setOpeningRemote] = useState(false);
    const [folderBusy, setFolderBusy] = useState(false);
    const [folderError, setFolderError] = useState(null);
    const [showHidden, setShowHidden] = useState(false);
    const [nativePicking, setNativePicking] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [removingId, setRemovingId] = useState(null);
    const generation = useRef(0);
    const activeRequest = useRef(null);
    const configGeneration = useRef(0);
    const configRequest = useRef(null);
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const paneRef = useRef(pane);
    paneRef.current = pane;
    const dialogRef = useDialogA11y(open, () => { onCancel(); });
    const folderDialogRef = useDialogA11y(folderDraft !== null, () => { if (!folderBusy)
        setFolderDraft(null); });
    const deleteDialogRef = useDialogA11y(deleteTarget !== null, () => { if (removingId === null)
        setDeleteTarget(null); });
    const confirmDialogRef = useDialogA11y(confirmTarget !== null, () => { if (hostPending === null)
        setConfirmTarget(null); });
    /** List one level, guarding against superseded/closed generations. */
    const loadLevel = async (request) => {
        const current = generation.current += 1;
        const controller = new AbortController();
        activeRequest.current = controller;
        setPane(previous => ({ ...previous, loading: true, error: null }));
        try {
            const listing = await request(controller.signal);
            if (current !== generation.current || controller.signal.aborted)
                return;
            setPane({ path: listing.path, listing, error: null, loading: false });
        }
        catch (error) {
            if (current !== generation.current || controller.signal.aborted)
                return;
            setPane(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
        }
    };
    const navigateLocal = (path) => {
        setMode({ kind: 'local' });
        void loadLevel(signal => listLocalDirectory(path, signal));
    };
    const navigateRemote = (id, path) => {
        setMode({ kind: 'remote', id });
        void loadLevel(async (signal) => asListing(unwrap(await rpc('browse.list', { id, ...(path !== undefined ? { path } : {}) }, signal), 'browse.list failed')));
    };
    const openRemotePath = async () => {
        if (mode.kind !== 'remote' || pane.path === null || openingRemote)
            return;
        setOpeningRemote(true);
        try {
            // The host mkdir's the session cwd locally, so hand it the local
            // placeholder that stands in for the remote route (both spellings
            // resolve to the same registry connection in the providers). Adopt it
            // through the host's own pick flow: the session gets a workspaceId
            // (the web hero gates cwd-only sessions), and the placeholder routes
            // every bash/fs/terminal operation onto the remote host.
            const routed = unwrap(await rpc('session.route', { id: mode.id, path: pane.path }), 'session.route failed');
            const cwd = isRecord(routed) && typeof routed.cwd === 'string' ? routed.cwd : '';
            if (cwd === '')
                throw new Error('session.route 未返回会话目录');
            onPicked(cwd);
        }
        catch (error) {
            setPane(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        }
        finally {
            setOpeningRemote(false);
        }
    };
    /**
     * Refresh the connection list. `silent` keeps the previous list on screen
     * (post-mutation refreshes) instead of flashing the skeleton.
     */
    const refreshConnections = async (silent = false) => {
        if (!silent)
            setConnectionsLoading(true);
        try {
            const value = unwrap(await rpc('connections.list'), 'connections.list failed');
            if (Array.isArray(value)) {
                setConnections(value.filter(isRecord).map(asConnectionView));
                setConnectionsError(null);
            }
        }
        catch (error) {
            setConnectionsError(error instanceof Error ? error.message : String(error));
        }
        finally {
            if (!silent)
                setConnectionsLoading(false);
        }
    };
    /**
     * Refresh the `~/.ssh/config` host list (the Host re-reads the file on every
     * call). Same generation + abort guard as the directory pane so closing the
     * dialog or a rapid retry can never apply a stale answer.
     */
    const refreshConfigHosts = async (silent = false) => {
        if (!silent)
            setConfigLoading(true);
        const current = configGeneration.current += 1;
        const controller = new AbortController();
        configRequest.current = controller;
        try {
            const value = unwrap(await rpc('config.hosts', {}, controller.signal), 'config.hosts failed');
            if (current !== configGeneration.current || controller.signal.aborted)
                return;
            setConfigHosts(asConfigHosts(value));
            setConfigError(null);
        }
        catch (error) {
            if (current !== configGeneration.current || controller.signal.aborted)
                return;
            setConfigError(error instanceof Error ? error.message : String(error));
        }
        finally {
            if (current === configGeneration.current && !silent)
                setConfigLoading(false);
        }
    };
    /** Open: refresh both sidebar lists and land on the local home. Closed: abort. */
    useEffect(() => {
        if (!open) {
            generation.current += 1;
            activeRequest.current?.abort();
            activeRequest.current = null;
            configGeneration.current += 1;
            configRequest.current?.abort();
            configRequest.current = null;
            return;
        }
        generation.current += 1;
        setPane(EMPTY_PANE);
        setFolderDraft(null);
        setFormOpen(false);
        setFormDraft(undefined);
        setOpeningRemote(false);
        setDeleteTarget(null);
        setRemovingId(null);
        setHostPending(null);
        setHostError(null);
        setConfirmTarget(null);
        setNativePicking(false);
        setMode({ kind: 'local' });
        void refreshConnections();
        void refreshConfigHosts();
        void loadLevel(signal => listLocalDirectory(undefined, signal));
    }, [open]);
    /** The active connection view (undefined while browsing locally). */
    const activeConnection = mode.kind === 'remote' ? connections.find(connection => connection.id === mode.id) : undefined;
    const activePath = pane.path ?? '';
    const refreshCurrent = () => {
        if (modeRef.current.kind === 'local')
            navigateLocal(paneRef.current.path ?? undefined);
        else
            navigateRemote(modeRef.current.id, paneRef.current.path ?? undefined);
    };
    /** One OS folder chooser on the host display; a pick lands straight as the workspace. */
    const pickNative = async () => {
        if (mode.kind !== 'local' || nativePicking)
            return;
        setNativePicking(true);
        try {
            const result = unwrap(await rpc('local.pickNative'), 'local.pickNative failed');
            const path = isRecord(result) && typeof result.path === 'string' ? result.path : '';
            if (path !== '')
                onPicked(path);
        }
        catch (error) {
            setPane(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        }
        finally {
            setNativePicking(false);
        }
    };
    /** The registry entry a config alias points at, if it was registered before. */
    const matchConfigHost = (host) => connections.find(connection => connection.port === host.port
        && (connection.host.toLowerCase() === host.alias.toLowerCase()
            || connection.host.toLowerCase() === host.host.toLowerCase()));
    const openForm = (draft) => {
        setFormDraft(draft);
        setFormOpen(true);
    };
    /**
     * One click on a config host: switch to its registered entry when there is
     * one; otherwise resolve the alias first. A missing username routes to the
     * prefilled form (the registry refuses empty usernames); anything else asks
     * for confirmation before it is registered and browsed.
     */
    const activateConfigHost = async (host) => {
        if (hostPending !== null)
            return;
        const existing = matchConfigHost(host);
        if (existing !== undefined) {
            setHostError(null);
            navigateRemote(existing.id);
            return;
        }
        setHostError(null);
        setHostPending(host.alias);
        try {
            const resolved = asResolved(unwrap(await rpc('connections.resolve', { host: host.alias }), 'connections.resolve failed'));
            if (resolved.host === '')
                throw new Error('别名解析结果为空');
            if (resolved.username.trim() === '') {
                openForm({
                    label: host.alias,
                    host: resolved.host,
                    port: String(resolved.port),
                    username: '',
                    ...(resolved.privateKeyPaths[0] !== undefined ? { privateKeyPath: resolved.privateKeyPaths[0] } : {}),
                    ...(resolved.jump.length > 0 ? { jumpText: resolved.jump.map(hop => `${hop.username !== undefined && hop.username !== '' ? `${hop.username}@` : ''}${hop.host}${hop.port !== undefined && hop.port !== 22 ? `:${String(hop.port)}` : ''}`).join(', ') } : {}),
                    focusUsername: true,
                });
                return;
            }
            setConfirmTarget({ host, resolved });
        }
        catch (error) {
            setHostError({ alias: host.alias, message: error instanceof Error ? error.message : String(error) });
        }
        finally {
            setHostPending(null);
        }
    };
    /** Confirmed: register the config host and browse its home right away. */
    const confirmAddHost = async () => {
        if (confirmTarget === null || hostPending !== null)
            return;
        const { host, resolved } = confirmTarget;
        setHostError(null);
        setHostPending(host.alias);
        try {
            const result = await rpc('connections.add', {
                label: host.alias,
                host: resolved.host,
                port: resolved.port,
                username: resolved.username,
                ...(resolved.privateKeyPaths[0] !== undefined ? { privateKeyPath: resolved.privateKeyPaths[0] } : {}),
                ...(resolved.jump.length > 0 ? { jump: resolved.jump } : {}),
            });
            const view = asAddedView(unwrap(result, 'connections.add failed'));
            if (view.id === '')
                throw new Error('注册结果缺少连接 id');
            setConfirmTarget(null);
            await refreshConnections(true);
            await refreshConfigHosts(true);
            navigateRemote(view.id);
        }
        catch (error) {
            setConfirmTarget(null);
            setHostError({ alias: host.alias, message: error instanceof Error ? error.message : String(error) });
        }
        finally {
            setHostPending(null);
        }
    };
    /** A prefilled form for the connection whose browse just failed on auth. */
    const draftFromConnection = (connection) => ({
        label: connection.label,
        host: connection.host,
        port: String(connection.port),
        username: connection.username,
        ...(connection.jumpHosts.length > 0 ? { jumpText: connection.jumpHosts.join(', ') } : {}),
    });
    const confirmCreateFolder = async () => {
        const name = (folderDraft ?? '').trim();
        if (name === '' || pane.path === null)
            return;
        if (name === '.' || name === '..' || /[/\\]/.test(name)) {
            setFolderError('名称不能包含 / 或 \\，也不能是 . 或 ..');
            return;
        }
        setFolderBusy(true);
        setFolderError(null);
        try {
            if (mode.kind === 'local') {
                await createLocalDirectory(pane.path, name);
            }
            else {
                unwrap(await rpc('browse.mkdir', { id: mode.id, path: pane.path, name }), 'browse.mkdir failed');
            }
            setFolderDraft(null);
            refreshCurrent();
        }
        catch (error) {
            setFolderError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setFolderBusy(false);
        }
    };
    const confirmRemove = async () => {
        if (deleteTarget === null || removingId !== null)
            return;
        setRemovingId(deleteTarget.id);
        try {
            unwrap(await rpc('connections.remove', { id: deleteTarget.id }), 'connections.remove failed');
            await refreshConnections(true);
            await refreshConfigHosts(true);
            if (mode.kind === 'remote' && mode.id === deleteTarget.id) {
                setMode({ kind: 'local' });
                void loadLevel(signal => listLocalDirectory(undefined, signal));
            }
        }
        catch (error) {
            setConnectionsError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setRemovingId(null);
            setDeleteTarget(null);
        }
    };
    const formResolve = async (host) => unwrap(await rpc('connections.resolve', { host }), 'connections.resolve failed');
    const formTest = async (input) => {
        const result = await rpc('connections.test', input);
        if (result.ok)
            return { ok: true };
        return { ok: false, message: result.error.message };
    };
    const formSave = async (input) => {
        const result = await rpc('connections.add', input);
        if (!result.ok)
            return { ok: false, message: result.error.message };
        const view = asAddedView(result.value);
        return { ok: true, ...(view.id !== '' ? { view } : {}) };
    };
    const formSaved = async (view) => {
        setFormOpen(false);
        setFormDraft(undefined);
        await refreshConnections(true);
        await refreshConfigHosts(true);
        navigateRemote(view.id);
    };
    const hiddenCount = (pane.listing?.entries ?? []).filter(entry => entry.hidden).length;
    const visibleEntries = (pane.listing?.entries ?? []).filter(entry => showHidden || !entry.hidden);
    const home = pane.listing?.home ?? '';
    const crumbs = pane.listing?.crumbs ?? [];
    const lastCrumbIndex = crumbs.length - 1;
    const subtitle = mode.kind === 'local'
        ? '选择一个本机目录作为新工作区'
        : `正在浏览 ${activeConnection !== undefined ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}` : mode.id} 的远程目录`;
    /** The translated remote failure for the right pane, when there is one. */
    const remoteFailure = mode.kind === 'remote' && pane.error !== null ? describeRemoteFailure(pane.error) : null;
    if (!open)
        return null;
    return (_jsxs("div", { className: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget)
            onCancel(); }, children: [_jsxs("div", { className: styles.dialog, role: "dialog", "aria-modal": "true", "aria-label": "\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55", ref: dialogRef, children: [_jsxs("header", { className: styles.header, children: [_jsxs("div", { className: styles.headerText, children: [_jsx("h3", { className: styles.title, children: "\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55" }), _jsx("p", { className: styles.subtitle, children: subtitle })] }), _jsx("button", { type: "button", className: styles.iconButton, "aria-label": "\u5173\u95ED", onClick: onCancel, children: _jsx(CloseIcon, {}) })] }), _jsxs("div", { className: styles.body, children: [_jsxs("nav", { className: styles.sidebar, "aria-label": "\u8FDE\u63A5\u4E0E\u4F4D\u7F6E", children: [_jsx("section", { className: styles.sidebarSection, "aria-label": "\u672C\u673A", children: _jsx("ul", { className: styles.connectionList, role: "list", children: _jsx("li", { className: cx(styles.connectionItem, mode.kind === 'local' && styles.connectionItemActive), children: _jsxs("button", { type: "button", className: styles.connectionMain, "aria-current": mode.kind === 'local' ? 'true' : 'false', onClick: () => { if (mode.kind !== 'local')
                                                        navigateLocal(); }, children: [_jsx(MonitorIcon, { className: styles.connectionIcon }), _jsxs("span", { className: styles.connectionInfo, children: [_jsx("span", { className: styles.connectionLabel, children: "\u672C\u673A\u76EE\u5F55" }), _jsx("span", { className: styles.connectionDetail, children: _jsx("span", { className: styles.connectionEndpoint, children: "\u9009\u62E9\u672C\u673A\u76EE\u5F55\u4F5C\u4E3A\u5DE5\u4F5C\u533A" }) })] })] }) }) }) }), _jsxs("section", { className: styles.sidebarSection, "aria-label": "\u5DF2\u4FDD\u5B58\u8FDE\u63A5", children: [_jsxs("h4", { className: styles.sidebarTitle, children: ["\u5DF2\u4FDD\u5B58\u8FDE\u63A5", connections.length > 0 && _jsx("span", { className: styles.sidebarCount, children: connections.length })] }), connectionsLoading && (_jsx("div", { role: "status", "aria-label": "\u6B63\u5728\u52A0\u8F7D\u5DF2\u4FDD\u5B58\u8FDE\u63A5", children: [0, 1].map(index => (_jsxs("div", { className: styles.skeletonRow, children: [_jsx("div", { className: styles.skeletonDot }), _jsxs("div", { className: styles.skeletonLines, children: [_jsx("div", { className: styles.skeletonLine, style: { width: '38%' } }), _jsx("div", { className: styles.skeletonLine, style: { width: '62%' } })] })] }, index))) })), connectionsError !== null && !connectionsLoading && (_jsxs("div", { className: styles.sideError, role: "alert", children: [_jsx("span", { className: styles.sideErrorText, children: connectionsError }), _jsxs("button", { type: "button", className: styles.retryButton, onClick: () => { void refreshConnections(); }, children: [_jsx(RefreshIcon, { style: { width: 12, height: 12 } }), "\u91CD\u8BD5"] })] })), !connectionsLoading && connectionsError === null && connections.length === 0 && (_jsxs("div", { className: styles.sideEmpty, children: [_jsx(ServerIcon, { className: styles.sideEmptyIcon, style: { width: 18, height: 18 } }), _jsx("p", { className: styles.sideEmptyTitle, children: "\u8FD8\u6CA1\u6709\u4FDD\u5B58\u7684\u8FDE\u63A5" }), _jsx("p", { className: styles.sideEmptyText, children: "\u70B9\u53F3\u4E0B\u89D2\u300C\uFF0B\u300D\u65B0\u5EFA\uFF0C\u6216\u4ECE\u4E0B\u65B9 SSH \u914D\u7F6E\u4E3B\u673A\u4E00\u952E\u6DFB\u52A0\u3002" })] })), !connectionsLoading && connections.length > 0 && (_jsx("ul", { className: styles.connectionList, role: "list", children: connections.map(connection => {
                                                    const active = mode.kind === 'remote' && mode.id === connection.id;
                                                    return (_jsxs("li", { className: cx(styles.connectionItem, active && styles.connectionItemActive), children: [_jsxs("button", { type: "button", className: styles.connectionMain, "aria-current": active ? 'true' : 'false', onClick: () => { navigateRemote(connection.id); }, children: [_jsx(ServerIcon, { className: styles.connectionIcon }), _jsxs("span", { className: styles.connectionInfo, children: [_jsx("span", { className: styles.connectionLabel, children: connection.label }), _jsxs("span", { className: styles.connectionDetail, children: [_jsxs("span", { className: styles.connectionEndpoint, children: [connection.username, "@", connection.host, ":", connection.port] }), _jsxs("span", { className: styles.badge, children: [connection.auth === 'password' ? _jsx(LockIcon, { style: { width: 11, height: 11 } }) : _jsx(KeyIcon, { style: { width: 11, height: 11 } }), connection.auth === 'password' ? '密码' : connection.auth === 'agent' ? 'Agent' : '私钥'] }), connection.jumpHosts.length > 0 && (_jsxs("span", { className: styles.badge, title: connection.jumpHosts.join(' → '), children: [_jsx(RouteIcon, { style: { width: 11, height: 11 } }), "\u8DF3\u677F \u00D7", connection.jumpHosts.length] }))] })] })] }), _jsx("button", { type: "button", className: styles.connectionRemove, "aria-label": `删除连接 ${connection.label}`, title: "\u5220\u9664\u8FDE\u63A5", onClick: () => { setDeleteTarget(connection); }, children: _jsx(TrashIcon, { style: { width: 14, height: 14 } }) })] }, connection.id));
                                                }) }))] }), _jsxs("section", { className: styles.sidebarSection, "aria-label": "SSH \u914D\u7F6E\u4E3B\u673A", children: [_jsxs("h4", { className: styles.sidebarTitle, children: ["SSH \u914D\u7F6E\u4E3B\u673A", configHosts.length > 0 && _jsx("span", { className: styles.sidebarCount, children: configHosts.length })] }), configLoading && (_jsx("div", { role: "status", "aria-label": "\u6B63\u5728\u8BFB\u53D6 ~/.ssh/config", children: [0, 1].map(index => (_jsxs("div", { className: styles.skeletonRow, children: [_jsx("div", { className: styles.skeletonDot }), _jsxs("div", { className: styles.skeletonLines, children: [_jsx("div", { className: styles.skeletonLine, style: { width: '38%' } }), _jsx("div", { className: styles.skeletonLine, style: { width: '62%' } })] })] }, index))) })), configError !== null && !configLoading && (_jsxs("div", { className: styles.sideError, role: "alert", children: [_jsxs("span", { className: styles.sideErrorText, children: ["\u65E0\u6CD5\u8BFB\u53D6 ~/.ssh/config\uFF1A", configError] }), _jsxs("button", { type: "button", className: styles.retryButton, onClick: () => { void refreshConfigHosts(); }, children: [_jsx(RefreshIcon, { style: { width: 12, height: 12 } }), "\u91CD\u8BD5"] })] })), !configLoading && configError === null && configHosts.length === 0 && (_jsxs("div", { className: styles.sideEmpty, children: [_jsx("p", { className: styles.sideEmptyTitle, children: "\u672A\u53D1\u73B0 SSH \u914D\u7F6E\u4E3B\u673A" }), _jsx("p", { className: styles.sideEmptyText, children: "\u5728 ~/.ssh/config \u4E2D\u6DFB\u52A0 Host \u6761\u76EE\u540E\uFF0C\u8FD9\u91CC\u4F1A\u76F4\u63A5\u5217\u51FA\uFF0C\u70B9\u51FB\u5373\u53EF\u8FDE\u63A5\u3002" })] })), !configLoading && configHosts.length > 0 && (_jsx("ul", { className: styles.connectionList, role: "list", children: configHosts.map(host => {
                                                    const registered = matchConfigHost(host);
                                                    const working = hostPending === host.alias;
                                                    const failed = hostError !== null && hostError.alias === host.alias;
                                                    return (_jsx("li", { className: styles.connectionItem, children: _jsxs("button", { type: "button", className: styles.connectionMain, "aria-current": "false", disabled: hostPending !== null, title: registered !== undefined
                                                                ? `已注册为 ${registered.username}@${registered.host}:${registered.port}`
                                                                : host.username !== ''
                                                                    ? `${host.username}@${host.host}:${host.port} — 点击注册并浏览`
                                                                    : '未指定用户 — 点击打开表单补全', onClick: () => { void activateConfigHost(host); }, children: [_jsx(ServerIcon, { className: styles.connectionIcon }), _jsxs("span", { className: styles.connectionInfo, children: [_jsx("span", { className: styles.connectionLabel, children: host.alias }), _jsx("span", { className: styles.connectionDetail, children: working ? (_jsxs("span", { className: styles.hostWorking, children: [_jsx(SpinnerIcon, { className: cx(styles.spin, styles.hostSpinner) }), "\u6B63\u5728\u6DFB\u52A0\u5E76\u8FDE\u63A5\u2026"] })) : failed && hostError !== null ? (_jsxs("span", { className: styles.hostErrorText, role: "alert", children: ["\u6DFB\u52A0\u5931\u8D25\uFF1A", hostError.message] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: styles.connectionEndpoint, children: host.username !== '' ? `${host.username}@${host.host}:${host.port}` : '未指定用户' }), registered !== undefined ? (_jsxs("span", { className: cx(styles.badge, styles.badgeAdded), children: [_jsx(CheckIcon, { style: { width: 11, height: 11 } }), "\u5DF2\u6DFB\u52A0"] })) : (_jsxs(_Fragment, { children: [host.identityFile && (_jsxs("span", { className: styles.badge, children: [_jsx(KeyIcon, { style: { width: 11, height: 11 } }), "\u79C1\u94A5"] })), host.jump && (_jsxs("span", { className: styles.badge, children: [_jsx(RouteIcon, { style: { width: 11, height: 11 } }), "\u8DF3\u677F"] }))] }))] })) })] })] }) }, host.alias));
                                                }) }))] }), _jsx("button", { type: "button", className: styles.sidebarAdd, "aria-label": "\u65B0\u5EFA\u8FDE\u63A5", title: "\u65B0\u5EFA\u8FDE\u63A5", onClick: () => { openForm(); }, children: _jsx(PlusIcon, { style: { width: 14, height: 14 } }) })] }), _jsxs("div", { className: styles.main, children: [_jsxs("div", { className: styles.toolbar, children: [_jsxs("nav", { className: styles.crumbs, "aria-label": "\u5F53\u524D\u8DEF\u5F84", children: [_jsx("button", { type: "button", className: styles.crumb, "aria-label": "\u56DE\u5230\u4E3B\u76EE\u5F55", title: "\u4E3B\u76EE\u5F55", disabled: home === '' || pane.loading, onClick: () => {
                                                            if (mode.kind === 'local')
                                                                navigateLocal(home);
                                                            else
                                                                navigateRemote(mode.id, home);
                                                        }, children: _jsx(HomeIcon, { style: { width: 13, height: 13, verticalAlign: '-2px' } }) }), crumbs.map((crumb, index) => index === lastCrumbIndex ? (_jsx("span", { className: styles.crumbCurrent, "aria-current": "page", title: crumb.path, children: crumb.name }, crumb.path)) : (_jsxs("span", { className: styles.crumbStep, children: [_jsx("button", { type: "button", className: styles.crumb, disabled: pane.loading, onClick: () => {
                                                                    if (mode.kind === 'local')
                                                                        navigateLocal(crumb.path);
                                                                    else
                                                                        navigateRemote(mode.id, crumb.path);
                                                                }, children: crumb.name }), _jsx("span", { className: styles.crumbSep, "aria-hidden": true, children: "/" })] }, crumb.path)))] }), _jsxs("div", { className: styles.toolbarActions, children: [mode.kind === 'local' && (_jsxs("button", { type: "button", className: cx(styles.toolButton, styles.toolButtonText), "aria-label": "\u7528\u7CFB\u7EDF\u9009\u62E9\u5668\u9009\u62E9\u6587\u4EF6\u5939", title: "\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668", disabled: nativePicking || busy, onClick: () => { void pickNative(); }, children: [nativePicking ? _jsx(SpinnerIcon, { className: styles.spin }) : _jsx(FolderIcon, { style: { width: 13, height: 13 } }), "\u7CFB\u7EDF\u9009\u62E9\u5668"] })), _jsx("button", { type: "button", className: styles.toolButton, "aria-label": "\u5728\u5F53\u524D\u76EE\u5F55\u65B0\u5EFA\u6587\u4EF6\u5939", title: "\u65B0\u5EFA\u6587\u4EF6\u5939", disabled: pane.listing === null || pane.loading, onClick: () => {
                                                            setFolderDraft('');
                                                            setFolderError(null);
                                                        }, children: _jsx(FolderPlusIcon, {}) }), _jsxs("button", { type: "button", className: cx(styles.toolButton, showHidden && styles.toolButtonOn), "aria-pressed": showHidden, "aria-label": showHidden ? '隐藏以点开头的文件夹' : '显示以点开头的文件夹', title: showHidden ? '隐藏点开头的文件夹' : '显示点开头的文件夹', onClick: () => { setShowHidden(previous => !previous); }, children: [_jsx(EyeIcon, {}), !showHidden && hiddenCount > 0 && _jsx("span", { className: styles.countBadge, "aria-hidden": true, children: hiddenCount })] }), _jsx("button", { type: "button", className: styles.toolButton, "aria-label": "\u5237\u65B0\u5F53\u524D\u76EE\u5F55", title: "\u5237\u65B0", disabled: pane.loading || pane.listing === null, onClick: refreshCurrent, children: _jsx(RefreshIcon, { className: pane.loading ? styles.spin : undefined }) })] })] }), _jsxs("div", { className: cx(styles.browser, pane.loading && pane.listing !== null && styles.browserBusy), "aria-busy": pane.loading, children: [pane.loading && pane.listing === null && (_jsx("div", { className: styles.skeletons, role: "status", "aria-label": "\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55", children: [52, 78, 64, 90, 45, 71].map((width, index) => (_jsx("div", { className: styles.skeleton, style: { width: `${width}%` } }, index))) })), pane.error !== null && !pane.loading && (_jsxs("div", { className: styles.errorPanel, role: "alert", children: [_jsx(AlertIcon, { className: styles.errorIcon }), _jsxs("div", { className: styles.errorBody, children: [_jsx("p", { className: styles.errorTitle, children: remoteFailure !== null ? remoteFailure.title : mode.kind === 'remote' ? '无法读取远程目录' : '无法读取目录' }), _jsx("p", { className: styles.errorText, children: remoteFailure !== null ? remoteFailure.text : pane.error })] }), _jsxs("div", { className: styles.errorActions, children: [remoteFailure?.needsAuth === true && activeConnection !== undefined && (_jsxs("button", { type: "button", className: styles.retryButton, onClick: () => { openForm(draftFromConnection(activeConnection)); }, children: [_jsx(KeyIcon, { style: { width: 12, height: 12 } }), "\u8865\u5168\u8BA4\u8BC1"] })), _jsxs("button", { type: "button", className: styles.retryButton, onClick: refreshCurrent, children: [_jsx(RefreshIcon, { style: { width: 12, height: 12 } }), "\u91CD\u8BD5"] })] })] })), pane.listing !== null && visibleEntries.length === 0 && !pane.loading && pane.error === null && (_jsxs("div", { className: styles.emptyState, children: [_jsx(FolderIcon, { className: styles.emptyIcon, style: { width: 22, height: 22 } }), _jsx("p", { className: styles.emptyTitle, children: "\u6CA1\u6709\u5B50\u6587\u4EF6\u5939" }), _jsx("p", { className: styles.emptyText, children: hiddenCount > 0 && !showHidden
                                                            ? `另有 ${hiddenCount} 个点开头的文件夹未显示`
                                                            : '可直接在此目录新建文件夹，或选择上方路径' })] })), visibleEntries.length > 0 && (_jsx("ul", { className: styles.entryList, role: "list", children: visibleEntries.map(entry => (_jsx("li", { children: _jsxs("button", { type: "button", className: cx(styles.entry, entry.hidden && styles.entryHidden), onClick: () => {
                                                            if (mode.kind === 'local')
                                                                navigateLocal(entry.path);
                                                            else
                                                                navigateRemote(mode.id, entry.path);
                                                        }, children: [_jsx(FolderIcon, { className: styles.entryIcon }), _jsx("span", { className: styles.entryName, children: entry.name }), _jsx(ChevronIcon, { className: styles.entryChevron })] }) }, entry.path))) })), pane.listing?.truncated === true && (_jsx("p", { className: styles.truncated, children: "\u6587\u4EF6\u5939\u8FC7\u591A\uFF0C\u4EC5\u663E\u793A\u5F00\u5934\u90E8\u5206\u3002" }))] })] })] }), _jsxs("footer", { className: styles.footer, children: [_jsx("button", { type: "button", className: styles.button, disabled: busy, onClick: onCancel, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: cx(styles.button, styles.primary), disabled: pane.listing === null || pane.loading || busy || openingRemote || pane.path === null, onClick: () => {
                                    if (pane.path === null)
                                        return;
                                    if (mode.kind === 'local')
                                        onPicked(pane.path);
                                    else
                                        void openRemotePath();
                                }, children: [mode.kind === 'remote' && openingRemote && _jsx(SpinnerIcon, { className: styles.spin }), mode.kind === 'remote' ? (openingRemote ? '连接中…' : '连接并打开') : '选择目录'] })] })] }), folderDraft !== null && (_jsx("div", { className: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget && !folderBusy)
                    setFolderDraft(null); }, children: _jsxs("div", { className: styles.smallDialog, role: "dialog", "aria-modal": "true", "aria-label": "\u65B0\u5EFA\u6587\u4EF6\u5939", ref: folderDialogRef, children: [_jsx("h3", { className: styles.formTitle, children: "\u65B0\u5EFA\u6587\u4EF6\u5939" }), _jsxs("p", { className: styles.createIn, children: ["\u4F4D\u7F6E\uFF1A", _jsx("span", { className: cx(styles.mono, styles.createPath), children: activePath === '' ? '…' : activePath })] }), _jsx("input", { className: cx(styles.input, folderError !== null && styles.inputError), value: folderDraft, placeholder: "\u672A\u547D\u540D\u6587\u4EF6\u5939", disabled: folderBusy, onChange: (event) => { setFolderDraft(event.target.value); }, onKeyDown: (event) => { if (event.key === 'Enter' && !folderBusy)
                                void confirmCreateFolder(); } }), folderError !== null && _jsx("p", { className: styles.fieldError, role: "alert", children: folderError }), _jsxs("div", { className: styles.formActions, children: [_jsx("span", { className: styles.gap }), _jsx("button", { type: "button", className: styles.button, disabled: folderBusy, onClick: () => { setFolderDraft(null); }, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: cx(styles.button, styles.primary), disabled: folderBusy || (folderDraft ?? '').trim() === '', onClick: () => { void confirmCreateFolder(); }, children: [folderBusy && _jsx(SpinnerIcon, { className: styles.spin }), "\u521B\u5EFA"] })] })] }) })), deleteTarget !== null && (_jsx("div", { className: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget && removingId === null)
                    setDeleteTarget(null); }, children: _jsxs("div", { className: styles.smallDialog, role: "dialog", "aria-modal": "true", "aria-label": "\u5220\u9664\u8FDC\u7A0B\u8FDE\u63A5", ref: deleteDialogRef, children: [_jsxs("div", { className: styles.confirmHead, children: [_jsx("span", { className: styles.confirmIconWrap, children: _jsx(TrashIcon, {}) }), _jsxs("div", { children: [_jsxs("h3", { className: styles.formTitle, children: ["\u5220\u9664\u8FDE\u63A5\u300C", deleteTarget.label, "\u300D\uFF1F"] }), _jsxs("p", { className: styles.confirmText, children: ["\u5C06\u79FB\u9664 ", deleteTarget.username, "@", deleteTarget.host, ":", deleteTarget.port, " \u7684\u6CE8\u518C\u4FE1\u606F\uFF1B\u5220\u9664\u540E\u9700\u8981\u91CD\u65B0\u6DFB\u52A0\u624D\u80FD\u518D\u6B21\u8FDE\u63A5\u3002"] })] })] }), _jsxs("div", { className: styles.formActions, children: [_jsx("span", { className: styles.gap }), _jsx("button", { type: "button", className: styles.button, disabled: removingId !== null, onClick: () => { setDeleteTarget(null); }, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: cx(styles.button, styles.danger), disabled: removingId !== null, onClick: () => { void confirmRemove(); }, children: [removingId !== null && _jsx(SpinnerIcon, { className: styles.spin }), "\u5220\u9664"] })] })] }) })), confirmTarget !== null && (_jsx("div", { className: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget && hostPending === null)
                    setConfirmTarget(null); }, children: _jsxs("div", { className: styles.smallDialog, role: "dialog", "aria-modal": "true", "aria-label": "\u6DFB\u52A0 SSH \u914D\u7F6E\u4E3B\u673A", ref: confirmDialogRef, children: [_jsxs("div", { className: styles.confirmHead, children: [_jsx("span", { className: cx(styles.confirmIconWrap, styles.confirmIconInfo), children: _jsx(ServerIcon, {}) }), _jsxs("div", { children: [_jsxs("h3", { className: styles.formTitle, children: ["\u6DFB\u52A0\u8FDE\u63A5\u300C", confirmTarget.host.alias, "\u300D\uFF1F"] }), _jsxs("p", { className: styles.confirmText, children: ["\u5C06\u628A ", confirmTarget.resolved.username, "@", confirmTarget.resolved.host, ":", confirmTarget.resolved.port, confirmTarget.resolved.jump.length > 0 ? `（经 ${String(confirmTarget.resolved.jump.length)} 级跳板）` : '', "\u4FDD\u5B58\u5230\u300C\u5DF2\u4FDD\u5B58\u8FDE\u63A5\u300D\uFF0C\u5E76\u6253\u5F00\u5B83\u7684\u8FDC\u7A0B\u76EE\u5F55\u3002"] })] })] }), _jsxs("div", { className: styles.formActions, children: [_jsx("span", { className: styles.gap }), _jsx("button", { type: "button", className: styles.button, disabled: hostPending !== null, onClick: () => { setConfirmTarget(null); }, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: cx(styles.button, styles.primary), disabled: hostPending !== null, onClick: () => { void confirmAddHost(); }, children: [hostPending !== null && _jsx(SpinnerIcon, { className: styles.spin }), "\u6DFB\u52A0\u5E76\u8FDE\u63A5"] })] })] }) })), formOpen && (_jsx(ConnectionForm, { resolve: formResolve, test: formTest, save: formSave, draft: formDraft, onClose: () => { setFormOpen(false); setFormDraft(undefined); }, onSaved: (view) => { void formSaved(view); } }))] }));
}
//# sourceMappingURL=flow.js.map