/**
 * Route-aware SSH filesystem provider for the filesystem capability seam.
 * The aggregate `ctx.ssh` connection is the default transport; a cwd of the
 * form `ssh://<connectionId>/<path>` (or a target resolved from such a cwd)
 * routes every operation to that registry-owned connection.
 * @module @deepseek-ai/dsh-fs-ssh
 */
import { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs';
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
/** Route-aware remote filesystem backend. */
export declare class SshFileSystem extends FileSystem {
    static inject: string[];
    private readonly locks;
    private routeCwd;
    private routeTarget;
    private pathOf;
    private transportOf;
    resolve(path: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<FsTarget>;
    processPath(target: FsTarget): string;
    fileUrl(target: FsTarget): string;
    contains(parent: FsTarget, child: FsTarget): boolean;
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    lstat(path: string, opts?: {
        cwd?: string;
    }, signal?: AbortSignal): Promise<FsPathInfo | undefined>;
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
    streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
    listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
    writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>;
    editText(target: FsTarget, edit: FsEditRequest, expected?: {
        version: ReturnType<typeof FsVersion>;
    }, signal?: AbortSignal): Promise<FsEditOutcome>;
    private withLock;
    private canonicalPath;
    private probe;
    private requireRegular;
    private readBytesRaw;
    private checkWriteIntent;
    private readForDiff;
    private readForEdit;
    private writeAtomic;
    private removeStaging;
}
export default SshFileSystem;
