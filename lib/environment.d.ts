/** Shared remote-environment scrubbing for the SSH process and terminal launchers. */
import type { SshTransport } from './transport.ts';
/**
 * Read the remote login environment, cached on the shared connection owner.
 * @param ssh - connection owner backing this execution world.
 * @returns the remote environment as name/value entries.
 */
export declare function readRemoteEnvironment(ssh: SshTransport): Promise<Record<string, string>>;
/**
 * Remove harness-private and credential-shaped names from a remote environment.
 * @param environment - the remote environment to scrub.
 * @returns retained entries for the caller to overlay and serialize.
 */
export declare function scrubRemoteEnvironment(environment: Readonly<Record<string, string>>): Map<string, string>;
/**
 * Overlay explicit entries and serialize one validated environment for `env -i`.
 * @param scrubbed - the scrubbed remote base.
 * @param explicit - deliberate caller overrides; an `undefined` tombstone removes an ambient entry.
 * @returns shell-quoted `name=value` words accepted by `env -i --`.
 */
export declare function serializeEnvironment(scrubbed: ReadonlyMap<string, string>, explicit: Readonly<NodeJS.ProcessEnv> | undefined): string;
