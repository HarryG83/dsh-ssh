# 修复：Windows 下「选择工作区目录」无法切换盘符

- 补丁日期：2026-09-30
- 作用包：`dsh-ssh` 0.3.0-pre（本目录即修好后的完整插件包）
- 影响模块：`lib/picker.js`（`dsh-ssh/picker`，`ctx.directoryPicker` 的 `browse` 后端）
- 附带改动：`lib/picker.d.ts` 文档、`README.md` / `README.zh.md` 说明、`test/picker-drive-switch.test.mjs` 回归测试

## 症状（复现步骤）

1. 打开 Web 界面的「选择工作区目录」（首屏工作区选择器 / 侧边栏工作区浏览）。
2. 左侧选中「本机目录」，右侧面板显示 `C:\Users\<用户>`；上方路径面包屑为 `🏠 C:\ / Users / <用户>`。
3. 只能看到 **发起时所在盘** 的内容：点面包屑根 `C:\` 进到 `C:\`，里面只有 C 盘上的目录；
   点击其它任何地方都到不了 `D:\`、`E:\` …
4. 结论：右侧面板的路径树无法切换盘符（要选 D 盘的工程目录只能改用工具栏的「系统选择器」按钮）。

## 根因

`dsh-ssh/picker` 的本机分支（`SshDirectoryPicker.listLocal`）只把 `opendir(target)` 的**真实子目录**
作为行返回，面包屑（`crumbs`）也只按 `win32.dirname` 回溯到当前盘的根 `C:\` 为止。

Windows 上「盘符」不是某个目录的子项——`C:\` 的子项永远在 C 盘内部，所以：

- 行列表无法包含 `D:\`（它不是 `C:\` 的子目录）；
- 面包屑根就是 `C:\`，没有更高一层（Explorer 的「此电脑」）可以列出所有盘。

也就是说这不是前端渲染 bug，而是 **后端列举数据里根本没有通往其它盘符的跳转目标**；
前端（dsh-ssh 客户端 UI 的右侧目录浏览器）只能按后端返回的 `entries` 逐层进入。

## 改动

### 1. `lib/picker.js`

- 新增 `isWin32DriveRoot(path)`：判定当前层级是否正好是某个盘符的根（`C:\` / `C:/`）。
- 新增 `win32DriveRoots()`：并发探测 A:–Z: 共 26 个盘符根，返回可达的盘符根列表。
  - 每个字母的 `stat` 有 500 ms 上限（超时的字母直接视为不可达，不会卡住对话框）；
  - 结果按 10 s 缓存，连续在盘符根附近导航不会重复探测；
  - 探测只用 `node:fs/promises` 的 `stat`，无子进程、无原生依赖。
- `listLocal` 在组装 `entries` 时：若当前层级是盘符根，**先**把其它可达盘符根作为
  跳转行放进行列表（`{ name: 'D:\\', path: 'D:\\', hidden: false }`），并排除当前盘自身；
  这些行与真实子目录共享 `maxEntries` 预算，截断时同样置 `truncated`。

远端（SFTP）列举与 POSIX 主机行为完全不变。

### 上游 `src/picker.ts` 对应改动（便于回并仓库）

```ts
/**
 * True when `path` is the root of a Windows drive (`C:\`, `C:/`) — the closest
 * local level to Explorer's "This PC", and therefore the only level whose
 * children may legitimately name sibling drives.
 * @param path - candidate absolute Windows path.
 */
function isWin32DriveRoot(path: string): boolean {
    return /^[A-Za-z]:[\\/]$/.test(path);
}
/** Every drive letter Windows can assign (the probe set for one drive root). */
const win32DriveLetters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
/** Bound on one drive-root probe, so an unreachable mapping cannot stall a level. */
const driveProbeTimeoutMs = 500;
/** Lifetime of a probed drive list; navigating around a drive root reuses one probe burst. */
const driveProbeCacheMs = 10_000;
/** The last drive probe: when it ran and the accessible roots it saw. */
let lastDriveProbe: { at: number; roots: string[] } = { at: 0, roots: [] };

/** Probe one candidate drive root; null when absent, media-less or too slow. */
async function probeDriveRoot(letter: string): Promise<string | null> {
    const root = `${letter}:\\`;
    let expiry: NodeJS.Timeout | undefined;
    try {
        const probe = stat(root).then((value) => (value.isDirectory() ? root : null), () => null);
        const timeout = new Promise<null>((resolveTimeout) => {
            expiry = setTimeout(() => resolveTimeout(null), driveProbeTimeoutMs);
        });
        return await Promise.race([probe, timeout]);
    }
    finally {
        clearTimeout(expiry);
    }
}

/** Accessible Windows drive roots, probed once per cache window. */
async function win32DriveRoots(): Promise<string[]> {
    const now = Date.now();
    if (now - lastDriveProbe.at < driveProbeCacheMs)
        return lastDriveProbe.roots;
    const probed = await Promise.all(win32DriveLetters.map((letter) => probeDriveRoot(letter)));
    const roots = probed.filter((root): root is string => root !== null);
    lastDriveProbe = { at: now, roots };
    return roots;
}
```

`listLocal` 中，`const entries: DirectoryEntry[] = [];` 之后、真实子目录循环之前插入：

```ts
        // A drive root is the only local level where another drive can be
        // reached at all: its real children live inside the current drive.
        if (isWin32DriveRoot(target)) {
            const current = target.slice(0, 2).toUpperCase();
            const roots = await win32DriveRoots();
            signal?.throwIfAborted();
            for (const root of roots) {
                if (root.slice(0, 2).toUpperCase() === current)
                    continue;
                if (entries.length === this.config.maxEntries) {
                    truncated = true;
                    break;
                }
                entries.push({ name: root, path: root, hidden: false });
            }
        }
```

### 2. `lib/picker.js.map` 已移除

`lib/picker.js` 是发布产物，本次为**直接热修编译产物**（包内不含 `src/`）。
原 `picker.js.map` 的行映射在插入代码后会整体错位，继续随包发布只会给出错误的
TS 行号，因此连同文件末尾的 `//# sourceMappingURL=picker.js.map` 一并移除。
`lib/` 下其余模块的 source map 未受影响。

## 验证（本机，Windows，盘符 C: / D:）

包内回归测试：`node test/picker-drive-switch.test.mjs`（在包目录下执行，
以便解析 `@deepseek-ai/*` 依赖）。

修复前（用备份的原始 `picker.js` 跑同一测试）：

```
platform=win32 cwd-root=C:\ accessible-drives=C:\ D:\
AssertionError: drive root C:\ must list exactly the other accessible drives
+ actual - expected
+ []
- [ 'D:\\' ]
exit=1
```

修复后：

```
platform=win32 cwd-root=C:\ accessible-drives=C:\ D:\
OK: Windows drive switch verified
```

测试覆盖：盘符根列出其它盘符且不含自身；真实子目录层级（如用户主目录）不掺入盘符行；
`C:/` 写法归一化到 `C:\`；已中止的调用仍然 reject；盘符行计入 `maxEntries`；
`capability().kind` 仍为 `browse`，非法目录名仍在触盘前被拒。

额外的接缝集成探针（`ctx.plugin(SshDirectoryPicker, config)` → 取 `ctx.directoryPicker`
的 `browse` 能力 → `list('C:\\')`，用桩 `ssh` 服务，验证加载器路径而不只是直接 new）：

```
service= SshDirectoryPicker kind= browse
path= C:\ crumbs= C:\
drive rows= D:\
OK: picker registered and drive root lists jump targets
```

（该探针留在工作区 `analysis/picker-registration-check.mjs`，未随包发布：它依赖 cordis
的异步 fiber 激活时序，作为一次性证据而非长期测试。）

## 使用与生效

- 生效方式：本补丁改的是宿主侧模块，DSH 桌面端需要**重启应用**（或重新加载该插件行）
  后才会加载新的 `lib/picker.js`；浏览器刷新不够。
- 界面操作：打开「选择工作区目录」→ 右侧面板上方面包屑点最左侧的盘符根（如 `C:\`）→
  列表首部即出现其它盘符（如 `D:\`）→ 点击即切换盘符。
- 回滚：用 `backup/dsh-ssh-original-<时间戳>/` 覆盖回包目录即可（含原始 `lib/picker.js.map`）。

## 风险与边界

- 与接缝文档的差异：`@deepseek-ai/dsh-host-directory-picker` 的 `DirectoryListing.entries`
  文档写的是「直接子目录」。盘符行是**跳转目标**而非子目录，形状仍是标准 `DirectoryEntry`
  （`name` = `path` = `D:\`、`hidden: false`），客户端按普通行渲染。若上游希望更严谨，
  可在接缝的 `DirectoryListing` 文档里补一句「本地根层级可包含同级跳转目标行」。
- 盘符探测是对 A:–Z: 各发一次 `stat`：本机固定盘几乎瞬时；若存在已断开的网络映射盘，
  该字母会在 500 ms 后被跳过（不显示、不阻塞），但底层 `stat` 仍会在系统线程池里等待
  其网络超时——这是本方案已知的唯一代价，换来的是零子进程、零原生依赖。
- 只列出「现在可达」的盘符：未插介质的光驱/读卡器、未连上的网络盘不会出现。
- 盘符根本身不可读（如空光驱）时仍按原有行为报 `directory-unreadable`，可在错误面板
  用「重试」或左侧「本机目录」重新进入；由于盘符行只在可读层级返回，此时其它盘符暂无
  列表入口，可改用工具栏「系统选择器」。
