/**
 * The add-workspace directory flow of dsh-ssh, laid out as a connection
 * sidebar beside a directory browser (VS Code Remote Explorer style): the
 * sidebar lists `~/.ssh/config` hosts (one click resolves, registers, and
 * browses — no form), saved connections, and the local entry; the right pane
 * browses whichever side is active. Picking a remote directory hands the owner
 * an `ssh://<id><path>` workspace path, which the deployment's remote
 * providers consume (see README for the workspace-adoption seam).
 */
import type { WireListing, WireResult } from './index.ts';
/** Services the plugin injects into every registration. */
export interface FlowInjected {
    listLocalDirectory(path?: string, signal?: AbortSignal): Promise<WireListing>;
    createLocalDirectory(path: string, name: string): Promise<string>;
    rpc(endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<WireResult>;
}
/** The owner share of the directory-flow holes (see ui-workspace's contract). */
export interface FlowProps {
    open: boolean;
    busy: boolean;
    onPicked(path: string): void;
    onCancel(): void;
    onError(message: string): void;
}
/** The directory-flow occupant registered into both workspace holes. */
export declare function SshWorkspaceFlow(props: FlowProps & FlowInjected): import("react").JSX.Element | null;
