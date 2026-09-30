# 修复：Windows「系统选择器」选中目录后报「无法读取目录 / worker exited before reporting a result」

- 补丁日期：2026-09-30
- 触发入口：`dsh-ssh/picker` 客户端「选择工作区目录」→ 工具栏「系统选择器」按钮
  （`local.pickNative`，实现在 `lib/web.js`）
- 根因包：`@deepseek-ai/dsh-host-directory-picker-native@0.1.0-rc.8`
- 本仓库改动：依赖范围升到 `^0.2.0-rc.2`（`package.json` + `package-lock.json`），
  并加入回归测试 `test/native-picker-version.test.mjs`

## 症状

1. 打开「选择工作区目录」，左侧选「本机目录」。
2. 点「系统选择器」，Windows 原生文件夹对话框（标题 `Select Workspace Directory`）正常弹出。
3. **取消**（「取消」/Esc）一切正常；**只要点「选择文件夹」确认选中目录**，对话框关闭的瞬间报错。
4. 界面显示 `无法读取目录` + `win32 folder dialog worker exited before reporting a result`，
   目录没被采用。

「无法读取目录」只是客户端给 `directory-unreadable` 类别的文案，真正死掉的是原生选择器的
worker 子进程。

## 调用链与根因

```
客户端「系统选择器」
  → RPC `local.pickNative`                      (lib/web.js)
    → pickNativeDirectory(signal)               @deepseek-ai/dsh-host-directory-picker-native
      → pickWin32Directory(signal)              win32 驱动（宿主主线程）
        → spawn(process.execPath, [worker.cjs], stdio: [ignore, inherit, inherit, ipc])
          → worker.cjs: dialog.show()           ← 用户看到的原生对话框
              → 选中后 dialog.resultPath() → readUtf16()    ← 进程在这里被终止
        ← 驱动只收到 'exit'，没有 {kind:'done'}，于是 reject 出用户看到的那句话
```

0.1.0-rc.8 的 `lib/worker.cjs` 这样读回路径：

```js
function readUtf16(koffi, address) {
    const bytes = Buffer.from(koffi.view(address, 32768));
    ...
}
```

koffi 的 `_Out_ void **` 出参给的是裸地址（实测为 `BigInt`）。在宿主运行环境
（Electron 44 / Node 24 以 Node 模式运行，koffi 3.3.2）下，`koffi.view(裸地址, n)` +
`Buffer.from(...)` 会让 koffi 直接 `napi_fatal_error` 终止进程——**与长度无关**
（实测 n = 2 / 38 / 32768 全部一样崩）：

```
FATAL ERROR: Error::New napi_get_last_error_info
----- Native stack trace -----
 2: napi_fatal_error+196
 3: napi_register_module_v1+...                 ← koffi.node
----- JavaScript stack trace -----
1: readUtf16 (...\dsh-host-directory-picker-native\lib\worker.cjs:22:34)
2: resultPath (...\worker.cjs:132:20)
3: runFolderDialog (...\worker.cjs:181:26)
```

退出码 134，所以驱动只看到 `exit`。取消路径不经过 `resultPath`，因此一直是好的。

### 为什么装的是坏版本

semver 规定：**预发布版本只在元组完全相同的比较符下才被匹配**。
`"@deepseek-ai/dsh-host-directory-picker-native": "^0.1.0-rc.6"` 只能命中 `0.1.0-*`，
永远命中不到 `0.1.1-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.2`，于是稳定解析到 0.1.0-rc.8；
而 harness 本体 `app.asar` 里打包的已经是修好的 0.2.0-rc.2。
0.2.0-rc.2 的 `readUtf16` 先把地址写进指针大小的缓冲区，再当 `str16` 指针变量解码，
koffi 顺着它读到 NUL 结束符为止，只读真实分配的那几十字节。

## 改动

1. `package.json`：`"@deepseek-ai/dsh-host-directory-picker-native": "^0.2.0-rc.2"`
   （必须是带 `0.2.0` 这个目标元组的预发布号；写成 `>=0.1.0-rc.6 <0.3.0` 一样只会命中 `0.1.0-*`）。
2. `package-lock.json` 重新解析：`-native` 0.1.0-rc.6 → 0.2.0-rc.2，
   新增嵌套的 `@deepseek-ai/dsh-host-directory-picker@0.2.0-rc.2`、
   `@deepseek-ai/dsh-native-command@0.2.0-rc.2`，并把 `koffi` 由 3.1.5 收到 0.2.0-rc.2 指定的 3.1.1；
   因为新包 peer 要求 `@deepseek-ai/cordis@~4.0.4`，共享的 cordis 由 4.0.1 提到 4.0.4（仍在自身的 `^4.0.1` 内）。
3. `test/native-picker-version.test.mjs`：清单或锁文件一旦漂回 0.1.0 线就失败
   （这个 bug 的本质是版本范围写错，所以回归测试盯的是范围与解析结果）。

## 验证（Windows，koffi 3.3.2；原始日志随修复包发布）

| 检查 | 结果 |
|---|---|
| 取消路径（0.1.0-rc.8） | `{"kind":"done","path":null}` + `exit 0`，正常 |
| 选中路径（0.1.0-rc.8） | `FATAL ERROR` → `exit code=134`，即用户报错 |
| 选中路径（0.2.0-rc.2） | `{"kind":"done","path":"D:\\workspace\\qldzrl\\playright"}` + `exit 0` |
| 抽出文件里实际发布的 `readUtf16` 对真实 COM 出参解码 | 0.2.0-rc.2：`"C:\\Users\\Lenovo\\Desktop"`；0.1.0-rc.8：`FATAL ERROR` |

本地可跑的检查（在包目录下）：

```sh
node test/native-picker-version.test.mjs     # 版本范围与锁文件解析
```

## 风险与边界

- 平级 seam 包 `@deepseek-ai/dsh-host-directory-picker` 仍留在 `^0.1.0-rc.6`，未一并升级：
  本插件只从 native 包 import 纯函数 `pickNativeDirectory`（不走 seam 的服务注册），
  实测 0.2.0-rc.2 下该函数行为正常；升 seam 会动到 `SshDirectoryPicker extends DirectoryPicker`
  这层契约，需要单独做兼容验证，不放进这次修复。
- 已装好的 profile 需要重新解析依赖（`npm/pnpm install`）才会拿到 0.2.0-rc.2；
  在那之前 Windows 系统选择器仍会报同样的错，属预期。
- 只影响 Windows 宿主分支；macOS 的 `osascript`、Linux 的 zenity/kdialog 分支不变。
- harness 侧（`app.asar`）不需要改动，它自带的就是 0.2.0-rc.2。
