import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The 「新建连接」form: one SSH connection with password or private-key
 * authentication (二选一), an optional ProxyJump chain, and `~/.ssh/config`
 * alias recognition through the Host channel. The host field is alias-first:
 * blur or paste auto-resolves and prefills (the manual 「识别 ssh 配置」 button
 * stays as the loud fallback), and a successful resolve shows a one-line
 * summary (alias → user@host:port, identity file, jump chain). A `draft`
 * prefills the form — the sidebar opens it this way when a config host needs
 * its username or auth completed.
 */
import { useEffect, useRef, useState } from 'react';
import { cx, useDialogA11y } from "./ui.js";
import { AlertIcon, CheckIcon, CloseIcon, KeyIcon, LockIcon, RouteIcon, SparkIcon, SpinnerIcon, } from "./icons.js";
import styles from './flow.module.css';
/** Parse a `[user@]host[:port]` jump list (comma/space separated). */
function parseJumpText(text) {
    const entries = text.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry !== '');
    return entries.map((entry) => {
        let rest = entry;
        let username;
        let port;
        const at = rest.lastIndexOf('@');
        if (at >= 0) {
            username = rest.slice(0, at);
            rest = rest.slice(at + 1);
        }
        const colon = rest.lastIndexOf(':');
        if (colon >= 0) {
            const parsed = Number(rest.slice(colon + 1));
            if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
                port = parsed;
                rest = rest.slice(0, colon);
            }
        }
        return {
            host: rest,
            ...(port !== undefined ? { port } : {}),
            ...(username !== undefined && username !== '' ? { username } : {}),
        };
    });
}
/** Render one resolved hop as `user@host:port` (defaults hidden). */
function formatHop(hop) {
    return `${hop.username !== undefined && hop.username !== '' ? `${hop.username}@` : ''}${hop.host}${hop.port !== undefined && hop.port !== 22 ? `:${String(hop.port)}` : ''}`;
}
/** The one-line resolve summary: alias → user@host:port · identity · jumps. */
function formatSummary(resolved) {
    const endpoint = `${resolved.username !== '' ? `${resolved.username}@` : ''}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ''}`;
    const parts = [];
    if (resolved.alias.toLowerCase() !== resolved.host.toLowerCase())
        parts.push(`${resolved.alias} → ${endpoint}`);
    else
        parts.push(endpoint);
    if (resolved.privateKeyPaths[0] !== undefined)
        parts.push(`私钥 ${resolved.privateKeyPaths[0]}`);
    if (resolved.jump.length > 0)
        parts.push(`跳板 ${resolved.jump.map(formatHop).join(' → ')}`);
    return parts.join(' · ');
}
/** The connection form modal (masked password, 密码/私钥二选一). */
export function ConnectionForm({ resolve, test, save, draft, onClose, onSaved }) {
    const [label, setLabel] = useState(draft?.label ?? '');
    const [host, setHost] = useState(draft?.host ?? '');
    const [port, setPort] = useState(draft?.port ?? '22');
    const [username, setUsername] = useState(draft?.username ?? '');
    const [authKind, setAuthKind] = useState('key');
    const [password, setPassword] = useState('');
    const [privateKeyPath, setPrivateKeyPath] = useState(draft?.privateKeyPath ?? '');
    const [passphrase, setPassphrase] = useState('');
    const [jumpText, setJumpText] = useState(draft?.jumpText ?? '');
    const [cwd, setCwd] = useState(draft?.cwd ?? '');
    const [busy, setBusy] = useState(false);
    const [busyTask, setBusyTask] = useState(null);
    const [feedback, setFeedback] = useState(null);
    const [revealed, setRevealed] = useState(false);
    const [resolveSummary, setResolveSummary] = useState(null);
    const [autoBusy, setAutoBusy] = useState(false);
    const dialogRef = useDialogA11y(true, () => { if (!busy)
        onClose(); });
    const usernameRef = useRef(null);
    const autoGeneration = useRef(0);
    const lastAutoHost = useRef(null);
    const busyRef = useRef(false);
    busyRef.current = busy;
    /** A prefilled form that is missing its username focuses that field first. */
    useEffect(() => {
        if (draft?.focusUsername === true)
            usernameRef.current?.focus();
    }, [draft?.focusUsername]);
    const errors = () => {
        const result = {};
        if (host.trim() === '')
            result.host = '请填写主机名或 ~/.ssh/config 别名';
        const portText = port.trim();
        if (portText === '')
            result.port = '必填';
        else if (!/^\d+$/.test(portText))
            result.port = '端口必须是数字';
        else {
            const value = Number(portText);
            if (value < 1 || value > 65535)
                result.port = '端口范围 1–65535';
        }
        if (username.trim() === '')
            result.username = '请填写登录用户名';
        return result;
    };
    const errorOf = (key) => (revealed ? errors()[key] : undefined);
    const assemble = () => {
        const jump = parseJumpText(jumpText);
        const input = {
            host: host.trim(),
            ...(port.trim() !== '' && Number.isInteger(Number(port.trim())) ? { port: Number(port.trim()) } : {}),
            ...(username.trim() !== '' ? { username: username.trim() } : {}),
            ...(label.trim() !== '' ? { label: label.trim() } : {}),
            ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
            ...(jump.length > 0 ? { jump } : {}),
        };
        if (authKind === 'password' && password !== '')
            input.password = password;
        if (authKind === 'key' && privateKeyPath.trim() !== '')
            input.privateKeyPath = privateKeyPath.trim();
        if (authKind === 'key' && passphrase !== '')
            input.passphrase = passphrase;
        return input;
    };
    /** Prefill every field the resolution covers; keep operator edits elsewhere. */
    const applyResolved = (resolved) => {
        setHost(resolved.host);
        if (resolved.port !== 22)
            setPort(String(resolved.port));
        if (resolved.username !== '')
            setUsername(resolved.username);
        if (resolved.privateKeyPaths.length > 0) {
            setAuthKind('key');
            setPrivateKeyPath(resolved.privateKeyPaths[0]);
        }
        setJumpText(resolved.jump.map(formatHop).join(', '));
        const user = resolved.username !== '' ? resolved.username : username;
        if (cwd.trim() === '' && user.trim() !== '')
            setCwd(`/home/${user.trim()}`);
        setResolveSummary(resolved);
    };
    /**
     * Silent alias resolution for blur/paste: no validation reveal, no error
     * surface, never disables the form. Guarded by its own generation counter
     * so a stale answer cannot clobber a newer edit.
     */
    const autoResolve = async (value) => {
        const hostText = value.trim();
        if (hostText === '' || busyRef.current)
            return;
        if (lastAutoHost.current === hostText)
            return;
        lastAutoHost.current = hostText;
        const current = autoGeneration.current += 1;
        setAutoBusy(true);
        try {
            const resolved = await resolve(hostText);
            if (current !== autoGeneration.current)
                return;
            applyResolved(resolved);
        }
        catch {
            // Silent by design; the manual button reports the error.
        }
        finally {
            if (current === autoGeneration.current)
                setAutoBusy(false);
        }
    };
    const resolveConfig = async () => {
        setRevealed(true);
        if (host.trim() === '') {
            setFeedback({ kind: 'error', text: '请先填写主机名或 ~/.ssh/config 别名' });
            return;
        }
        autoGeneration.current += 1;
        // Any in-flight silent resolve is now superseded; drop its spinner for good.
        setAutoBusy(false);
        setBusy(true);
        setBusyTask('resolve');
        setFeedback({ kind: 'info', text: '正在读取 ~/.ssh/config…' });
        try {
            const resolved = await resolve(host.trim());
            lastAutoHost.current = resolved.host;
            applyResolved(resolved);
            setFeedback({
                kind: 'success',
                text: `已识别 ${resolved.alias} → ${resolved.username !== '' ? `${resolved.username}@` : ''}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ''}`,
            });
        }
        catch (error) {
            setFeedback({ kind: 'error', text: `识别失败：${error instanceof Error ? error.message : String(error)}` });
        }
        finally {
            setBusy(false);
            setBusyTask(null);
        }
    };
    const runTest = async () => {
        setRevealed(true);
        const input = assemble();
        if (host.trim() === '') {
            setFeedback({ kind: 'error', text: '请先填写主机名' });
            return;
        }
        if (authKind === 'password' && input.password === undefined) {
            setFeedback({ kind: 'error', text: '请填写密码，或改用私钥认证' });
            return;
        }
        if (authKind === 'key' && input.privateKeyPath === undefined) {
            setFeedback({ kind: 'error', text: '请填写私钥文件路径，或改用密码认证' });
            return;
        }
        setBusy(true);
        setBusyTask('test');
        setFeedback({ kind: 'info', text: '正在测试连接…' });
        try {
            const outcome = await test(input);
            setFeedback(outcome.ok
                ? { kind: 'success', text: '连接成功，可以保存了' }
                : { kind: 'error', text: `连接失败：${outcome.message ?? '未知错误'}` });
        }
        catch (error) {
            setFeedback({ kind: 'error', text: `测试失败：${error instanceof Error ? error.message : String(error)}` });
        }
        finally {
            setBusy(false);
            setBusyTask(null);
        }
    };
    const runSave = async () => {
        setRevealed(true);
        const found = errors();
        if (found.host !== undefined || found.port !== undefined || found.username !== undefined) {
            setFeedback({ kind: 'error', text: '请先补全上方必填项' });
            return;
        }
        const input = assemble();
        setBusy(true);
        setBusyTask('save');
        setFeedback({ kind: 'info', text: '正在保存…' });
        try {
            const outcome = await save(input);
            if (!outcome.ok || outcome.view === undefined) {
                setFeedback({ kind: 'error', text: `保存失败：${outcome.message ?? '未知错误'}` });
                return;
            }
            onSaved(outcome.view);
        }
        catch (error) {
            setFeedback({ kind: 'error', text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
        }
        finally {
            setBusy(false);
            setBusyTask(null);
        }
    };
    const hostError = errorOf('host');
    const portError = errorOf('port');
    const usernameError = errorOf('username');
    return (_jsx("div", { className: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget && !busy)
            onClose(); }, children: _jsxs("div", { className: styles.form, role: "dialog", "aria-modal": "true", "aria-label": "\u65B0\u5EFA\u8FDC\u7A0B\u8FDE\u63A5", ref: dialogRef, children: [_jsxs("div", { className: styles.formHead, children: [_jsxs("div", { className: styles.formHeadText, children: [_jsx("h3", { className: styles.formTitle, children: "\u65B0\u5EFA\u8FDC\u7A0B\u8FDE\u63A5" }), _jsx("p", { className: styles.formSub, children: "\u4FDD\u5B58\u540E\u5C06\u51FA\u73B0\u5728\u8FDE\u63A5\u4FA7\u680F\u4E2D\uFF0C\u53EF\u76F4\u63A5\u6D4F\u89C8\u5176\u8FDC\u7A0B\u76EE\u5F55" })] }), _jsx("button", { type: "button", className: styles.iconButton, "aria-label": "\u5173\u95ED", disabled: busy, onClick: onClose, children: _jsx(CloseIcon, {}) })] }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsxs("span", { className: styles.fieldLabel, children: ["\u4E3B\u673A\u540D / \u522B\u540D", _jsx("span", { className: styles.required, "aria-hidden": true, children: "*" })] }), _jsx("input", { className: cx(styles.input, hostError !== undefined && styles.inputError), value: host, placeholder: "prod \u6216 server.example.com", disabled: busy, onChange: event => {
                                        setHost(event.target.value);
                                        setResolveSummary(null);
                                        lastAutoHost.current = null;
                                    }, onBlur: () => { void autoResolve(host); }, onPaste: event => {
                                        const text = event.clipboardData.getData('text');
                                        if (text.trim() !== '')
                                            void autoResolve(text);
                                    } }), autoBusy && _jsx("span", { className: styles.fieldHint, role: "status", children: "\u6B63\u5728\u5339\u914D ~/.ssh/config\u2026" }), hostError !== undefined && _jsx("span", { className: styles.fieldError, children: hostError }), _jsx("span", { className: styles.fieldHint, children: "\u586B\u5199 ~/.ssh/config \u91CC\u7684\u522B\u540D\u53EF\u5728\u5931\u7126\u65F6\u81EA\u52A8\u8865\u5168\u7528\u6237\u540D\u3001\u7AEF\u53E3\u3001\u79C1\u94A5\u4E0E\u8DF3\u677F" })] }), resolveSummary !== null && (_jsxs("div", { className: cx(styles.feedback, styles.feedbackSuccess), role: "status", children: [_jsx(CheckIcon, {}), _jsx("span", { className: styles.mono, children: formatSummary(resolveSummary) })] })), _jsxs("div", { className: styles.rowFields, children: [_jsxs("label", { className: cx(styles.field, styles.fieldPort), children: [_jsxs("span", { className: styles.fieldLabel, children: ["\u7AEF\u53E3", _jsx("span", { className: styles.required, "aria-hidden": true, children: "*" })] }), _jsx("input", { className: cx(styles.input, portError !== undefined && styles.inputError), value: port, inputMode: "numeric", disabled: busy, onChange: event => { setPort(event.target.value); } }), portError !== undefined && _jsx("span", { className: styles.fieldError, children: portError })] }), _jsxs("label", { className: styles.field, children: [_jsxs("span", { className: styles.fieldLabel, children: ["\u7528\u6237\u540D", _jsx("span", { className: styles.required, "aria-hidden": true, children: "*" })] }), _jsx("input", { ref: usernameRef, className: cx(styles.input, usernameError !== undefined && styles.inputError), value: username, disabled: busy, onChange: event => { setUsername(event.target.value); } }), usernameError !== undefined && _jsx("span", { className: styles.fieldError, children: usernameError })] })] }), _jsxs("div", { className: styles.rowFields, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u540D\u79F0\uFF08\u53EF\u9009\uFF09" }), _jsx("input", { className: styles.input, value: label, placeholder: "\u9ED8\u8BA4 user@host", disabled: busy, onChange: event => { setLabel(event.target.value); } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF09" }), _jsx("input", { className: styles.input, value: cwd, placeholder: "/home/username", disabled: busy, onChange: event => { setCwd(event.target.value); } })] })] }), _jsxs("div", { className: styles.fieldGroup, children: [_jsx("span", { className: styles.fieldLabel, id: "dsh-ssh-auth-label", children: "\u8BA4\u8BC1\u65B9\u5F0F" }), _jsxs("div", { className: styles.segment, role: "radiogroup", "aria-labelledby": "dsh-ssh-auth-label", children: [_jsxs("button", { type: "button", role: "radio", "aria-checked": authKind === 'key', className: cx(styles.segmentButton, authKind === 'key' && styles.segmentButtonOn), disabled: busy, onClick: () => { setAuthKind('key'); }, children: [_jsx(KeyIcon, {}), "\u79C1\u94A5\u6587\u4EF6"] }), _jsxs("button", { type: "button", role: "radio", "aria-checked": authKind === 'password', className: cx(styles.segmentButton, authKind === 'password' && styles.segmentButtonOn), disabled: busy, onClick: () => { setAuthKind('password'); }, children: [_jsx(LockIcon, {}), "\u5BC6\u7801"] })] })] }), authKind === 'key' ? (_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u79C1\u94A5\u6587\u4EF6\u8DEF\u5F84" }), _jsx("input", { className: styles.input, value: privateKeyPath, placeholder: "~/.ssh/id_ed25519", disabled: busy, onChange: event => { setPrivateKeyPath(event.target.value); } })] })) : (_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u5BC6\u7801" }), _jsx("input", { type: "password", className: styles.input, value: password, disabled: busy, onChange: event => { setPassword(event.target.value); } })] })), authKind === 'key' && (_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u79C1\u94A5\u53E3\u4EE4\uFF08\u53EF\u9009\uFF09" }), _jsx("input", { type: "password", className: styles.input, value: passphrase, disabled: busy, onChange: event => { setPassphrase(event.target.value); } })] })), _jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u8DF3\u677F\u94FE\uFF08\u53EF\u9009\uFF09" }), _jsx("input", { className: styles.input, value: jumpText, placeholder: "bastion \u6216 user@bastion.example.com:2202\uFF0C\u591A\u53F0\u7528\u9017\u53F7\u5206\u9694", disabled: busy, onChange: event => { setJumpText(event.target.value); } }), _jsx("span", { className: styles.fieldHint, children: "\u652F\u6301 ~/.ssh/config \u522B\u540D\uFF1B\u683C\u5F0F user@host:port\uFF0C\u6309\u8FDE\u63A5\u987A\u5E8F\u6392\u5217" })] })] }), feedback !== null && (_jsxs("div", { className: cx(styles.feedback, feedback.kind === 'success' ? styles.feedbackSuccess : feedback.kind === 'error' ? styles.feedbackError : styles.feedbackInfo), role: feedback.kind === 'error' ? 'alert' : 'status', children: [busy
                            ? _jsx(SpinnerIcon, { className: styles.spin })
                            : feedback.kind === 'success'
                                ? _jsx(CheckIcon, {})
                                : feedback.kind === 'error'
                                    ? _jsx(AlertIcon, {})
                                    : null, _jsx("span", { children: feedback.text })] })), _jsxs("div", { className: styles.formActions, children: [_jsxs("button", { type: "button", className: styles.button, disabled: busy, onClick: () => { void resolveConfig(); }, children: [_jsx(SparkIcon, {}), "\u8BC6\u522B ssh \u914D\u7F6E"] }), _jsxs("button", { type: "button", className: styles.button, disabled: busy, onClick: () => { void runTest(); }, children: [_jsx(RouteIcon, {}), "\u6D4B\u8BD5\u8FDE\u63A5"] }), _jsx("span", { className: styles.gap }), _jsx("button", { type: "button", className: styles.button, disabled: busy, onClick: onClose, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: cx(styles.button, styles.primary), disabled: busy, onClick: () => { void runSave(); }, children: [busyTask === 'save' && _jsx(SpinnerIcon, { className: styles.spin }), "\u4FDD\u5B58\u8FDE\u63A5"] })] })] }) }));
}
//# sourceMappingURL=form.js.map