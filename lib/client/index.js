/**
 * Browser half of dsh-ssh: the add-workspace directory flow — a connection
 * sidebar (saved connections, `~/.ssh/config` hosts, local entry) beside the
 * directory browser. Registered into both directory-flow holes, so mounting
 * `dsh-ssh` composes the whole picking interaction. Cross-plane calls ride the
 * shared web transport: local listing through the client directory API
 * (`uiWorkspace`, falling back to `workspaces` — the Host's `directoryPicker`
 * browse capability) and remote listing/connection
 * management through the package's `/dsh-ssh` RPC channel.
 */
import { SshWorkspaceFlow } from "./flow.js";
/** Required client services: the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces'];
/**
 * Resolve the browser-side directory API: dsh >= 0.2.0-rc.2 moved the
 * `directoryPicker` browse capability from `workspaces` to `uiWorkspace`,
 * while older builds still expose it on `workspaces`.
 * @param ctx - client root context.
 * @returns the service exposing listDirectory/createDirectory.
 */
function directoryApi(ctx) {
    const uiWorkspace = ctx.get('uiWorkspace');
    if (uiWorkspace !== undefined && typeof uiWorkspace.listDirectory === 'function') {
        return uiWorkspace;
    }
    const workspaces = ctx.get('workspaces');
    if (workspaces !== undefined && typeof workspaces.listDirectory === 'function') {
        return workspaces;
    }
    throw new Error('dsh-ssh: no directory browsing service is available (uiWorkspace/workspaces)');
}
/**
 * Client plugin body: fill both directory-flow holes with the SSH workspace
 * flow. `slots.inject` waits for each hole's declaration, and the generator
 * installs the two registrations transactionally.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const injected = () => ({
        listLocalDirectory: (path, signal) => directoryApi(ctx).listDirectory(path, signal),
        createLocalDirectory: (path, name) => directoryApi(ctx).createDirectory(path, name),
        rpc: (endpoint, payload, signal) => {
            const connection = ctx.get('connection');
            if (connection === undefined) {
                return Promise.resolve({ ok: false, error: { code: 'internal', message: 'dsh-ssh: the web transport is not available' } });
            }
            return connection.rpc.call('/dsh-ssh', endpoint, payload ?? {}, signal);
        },
    });
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
        yield ctx.slots.register({
            name: 'conversation.hero.workspace.directoryFlow', inject: injected,
        }, SshWorkspaceFlow);
        yield ctx.slots.register({
            name: 'sidebar.workspaces.directoryFlow', inject: injected,
        }, SshWorkspaceFlow);
    }));
}
//# sourceMappingURL=index.js.map