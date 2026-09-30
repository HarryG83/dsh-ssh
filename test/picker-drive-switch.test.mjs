/**
 * Regression check for the Windows drive switch of `dsh-ssh/picker`.
 *
 * Symptom it pins down: in the "选择工作区目录" dialog the local browser could
 * never leave the drive it opened on, because a directory level only ever
 * lists its real children and no child of `C:\` names `D:\`.
 *
 * The check drives the shipped browse backend directly (`SshDirectoryPicker`)
 * with a stub `ssh` service, so no SSH connection is involved:
 *   1. a local drive root lists every other accessible drive root as a jump
 *      target, and never lists itself;
 *   2. a non-root local level (the home directory) stays free of drive rows;
 *   3. the `C:/` spelling normalizes onto the same drive root;
 *   4. an aborted caller still rejects;
 *   5. drive rows count toward `maxEntries`.
 *
 * Usage (from the package directory, so `@deepseek-ai/*` resolves):
 *   node test/picker-drive-switch.test.mjs [module-path]
 *
 * The optional module path lets the same check run against a different build
 * of the backend, which is how the pre-fix behaviour is demonstrated.
 */
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { Context } from '@deepseek-ai/cordis';

const modulePath = process.argv[2] ?? '../lib/picker.js';
const { SshDirectoryPicker } = await import(modulePath);

/** A picker over a stub `ssh` service: only local listing is exercised. */
function makePicker(config = {}) {
    const ctx = new Context();
    ctx.provide('ssh', {
        cwd: '/tmp',
        endpoint: 'stub@localhost:22',
        async getRemoteEnvironment() {
            return { HOME: '/tmp' };
        },
    });
    return new SshDirectoryPicker(ctx, { maxEntries: 1000, ...config });
}

/** Independently probe which drive roots this machine can reach right now. */
async function accessibleDriveRoots() {
    const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
    const roots = [];
    for (const letter of letters) {
        const root = `${letter}:\\`;
        try {
            if ((await stat(root)).isDirectory())
                roots.push(root);
        }
        catch {
            // An absent or media-less letter is simply not reachable.
        }
    }
    return roots;
}

/** True when `path` is itself a drive root. */
function isDriveRoot(path) {
    return /^[A-Za-z]:[\\/]$/.test(path);
}

/** Drive rows of a listing: rows that are drive roots. */
function driveRowsOf(listing) {
    return listing.entries.filter((entry) => isDriveRoot(entry.path));
}

if (process.platform !== 'win32') {
    console.log(`SKIP platform=${process.platform} — the drive switch is a Windows-only level`);
    process.exit(0);
}

const roots = await accessibleDriveRoots();
assert.ok(roots.length >= 1, 'expected at least one accessible drive root');
const currentRoot = win32.parse(process.cwd()).root; // e.g. C:\
const otherRoots = roots.filter((root) => root.toUpperCase() !== currentRoot.toUpperCase());
console.log(`platform=win32 cwd-root=${currentRoot} accessible-drives=${roots.join(' ')}`);

const picker = makePicker();

// 1. the current drive's root carries every other drive as a jump target.
const rootListing = await picker.list(currentRoot);
assert.equal(rootListing.path, currentRoot, 'the listing keeps the drive root as its path');
assert.deepEqual(
    driveRowsOf(rootListing).map((entry) => entry.path).sort(),
    [...otherRoots].sort(),
    `drive root ${currentRoot} must list exactly the other accessible drives`,
);
for (const row of driveRowsOf(rootListing)) {
    assert.equal(row.name, row.path, 'a drive row is named by its root path');
    assert.equal(row.hidden, false, 'a drive row is never hidden');
}
assert.equal(
    rootListing.crumbs[rootListing.crumbs.length - 1].path,
    currentRoot,
    'the breadcrumb root is the drive root itself',
);

// 2. a non-root local level keeps its real children only.
const home = homedir();
if (!isDriveRoot(home)) {
    const homeListing = await picker.list(home);
    assert.deepEqual(driveRowsOf(homeListing), [], `home ${home} must not carry drive rows`);
}

// 3. a forward-slash drive root normalizes onto the same level.
const slashListing = await picker.list(`${currentRoot.slice(0, 2)}/`);
assert.equal(slashListing.path, currentRoot, 'C:/ normalizes to C:\\');
assert.deepEqual(
    driveRowsOf(slashListing).map((entry) => entry.path).sort(),
    [...otherRoots].sort(),
    'the normalized drive root lists the same drives',
);

// 3b. following a drive row is the switch itself: the target drive becomes the
//     level and the breadcrumb root, which is what the browser does on click.
if (otherRoots.length > 0) {
    const target = driveRowsOf(rootListing)[0].path;
    const switched = await picker.list(target);
    assert.equal(switched.path, target, 'following a drive row lands on that drive');
    assert.equal(
        switched.crumbs[0].path,
        target,
        'the breadcrumb root follows the drive switch',
    );
}

// 4. an already-aborted caller still rejects.
await assert.rejects(
    () => picker.list(currentRoot, AbortSignal.abort()),
    'an aborted listing rejects',
);

// 5. drive rows are rows of the level: they obey maxEntries.
if (otherRoots.length > 0) {
    const bounded = makePicker({ maxEntries: 1 });
    const boundedListing = await bounded.list(currentRoot);
    assert.ok(boundedListing.entries.length <= 1, 'maxEntries bounds the level including drive rows');
}
else {
    console.log('note: single-drive machine — the multi-drive assertions ran vacuously');
}

// 6. the untouched contract: the capability kind and the create-name guard.
assert.equal(picker.capability().kind, 'browse', 'the seam capability stays the browse kind');
await assert.rejects(
    () => picker.createDirectory(currentRoot, 'nested/name'),
    'a multi-segment create name is still refused before any filesystem work',
);

console.log('OK: Windows drive switch verified');
