/**
 * Regression check for the Windows "系统选择器" crash of `dsh-ssh/picker`.
 *
 * Symptom it pins down: after picking a folder in the native chooser (the
 * "系统选择器" button of the add-workspace dialog), the UI reported
 * "无法读取目录 / win32 folder dialog worker exited before reporting a result".
 * The win32 dialog worker of
 * `@deepseek-ai/dsh-host-directory-picker-native@0.1.0-rc.8` aborts the whole
 * child process inside `readUtf16` the moment the dialog returns a selection
 * (`koffi.view(address, 32768)` + `Buffer.from(...)`), so the driver only ever
 * saw the child exit and never a `{kind:'done'}` message. Cancelling stayed
 * fine, which is what pointed at the result path rather than the dialog.
 *
 * The trigger was the version *range*, not plugin code: a caret range on a
 * prerelease only admits prereleases of that exact [major, minor, patch]
 * tuple, so `^0.1.0-rc.6` can never reach the fixed 0.2.0 line — it settles on
 * 0.1.0-rc.8, while the harness itself ships 0.2.0-rc.2 with the fixed
 * `readUtf16` (stage the address in a pointer-sized buffer, decode it as a
 * `str16` pointer variable).
 *
 * This check fails if the manifest or the lockfile drifts back to the 0.1.0
 * tuple:
 *   1. package.json declares the native picker on the 0.2+ line;
 *   2. package-lock.json resolves it to >= 0.2.0.
 *
 * Usage (from the package directory):
 *   node test/native-picker-version.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PACKAGE = '@deepseek-ai/dsh-host-directory-picker-native';
/** Last release of the 0.1.0 line: its win32 dialog worker aborts on a pick. */
const BROKEN = '0.1.0-rc.8';
/** First release carrying the fixed `readUtf16`. */
const FIXED = '0.2.0-rc.2';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const range = manifest.dependencies?.[PACKAGE];
assert.ok(typeof range === 'string' && range.length > 0, `${PACKAGE} must stay a runtime dependency`);
// Naming the 0.2 tuple is the whole fix: anything that can still resolve inside
// 0.0.x/0.1.x resolves to a build whose win32 dialog worker aborts.
assert.ok(
    !/^[\^~]?0\.[01]\./.test(range),
    `${PACKAGE} must not resolve inside the 0.1.0 line (got ${range}; ${BROKEN} aborts the win32 picker)`,
);

const resolved = lock.packages?.[`node_modules/${PACKAGE}`]?.version;
assert.ok(typeof resolved === 'string' && resolved.length > 0, `${PACKAGE} is missing from package-lock.json`);
const [major, minor] = resolved.split('.').map((part) => Number.parseInt(part, 10));
assert.ok(
    major > 0 || minor >= 2,
    `package-lock.json resolves ${PACKAGE}@${resolved}; ${FIXED} is the first fixed release`,
);

console.log(`manifest : ${PACKAGE}@${range}`);
console.log(`lockfile : ${PACKAGE}@${resolved}`);
console.log('OK: the native picker dependency stays on the fixed 0.2 line');
