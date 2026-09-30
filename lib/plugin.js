/**
 * One-row aggregate plugin: mounts the shared SSH connection owner plus the
 * remote subprocess and filesystem providers. `name: dsh-ssh` in cordis.yml
 * is equivalent to the three subpath rows (`dsh-ssh/ssh`, `dsh-ssh/subprocess`,
 * `dsh-ssh/fs`) and needs no `inject` — the subprocess and filesystem
 * providers resolve `ssh` through the same context.
 * @module dsh-ssh/plugin
 */
import SshRuntime from "./runtime.js";
import SshSubprocessRuntime from "./subprocess.js";
import SshFileSystem from "./filesystem-final.js";
/**
 * Mount the aggregate plugin.
 * @param ctx - the mounting Cordis context.
 * @param config - the shared SSH connection configuration.
 */
export function apply(ctx, config) {
    ctx.plugin(SshRuntime, config);
    ctx.plugin(SshSubprocessRuntime);
    ctx.plugin(SshFileSystem);
}
//# sourceMappingURL=plugin.js.map