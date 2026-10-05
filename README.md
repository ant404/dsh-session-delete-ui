# dsh-session-delete-ui

[English](#english) | 中文

DSH（DeepSeek Harness）插件：在**左侧会话行的「⋯」菜单**里补上官方的「**删除会话**」能力。

官方 Harness 只提供归档（Archive），没有删除：`dsh-session-persistence` 的文档明确写着
「**No deletion or retention API** — pruning stored sessions is out-of-band backend maintenance」。
本插件就是把这个 out-of-band 维护做进 UI，并且做得安全、可确认、可回退。

```
会话行 ⋯ 菜单
  ├─ 置顶 / 重命名 / 分叉 / 归档      ← 官方内置
  └─ 删除会话                        ← 本插件（order 500，独立分组，红色危险项）
        ↓
   确认对话框：会话名 + 「不可恢复」警告 + 将删除的子代理数量 + 占用空间
        ↓
   永久删除：会话日志目录 + 投影缓存 + 工作区记录（含子代理会话级联）
```

## 功能

| 入口 | 文案 | 行为 |
|---|---|---|
| 会话行「⋯」菜单 | **删除会话** | 永久删除该会话的本地日志目录、`session_projcache` 投影缓存、工作区账目（成员关系 / 归档 / 置顶标记） |
| 同上 → 确认对话框 | — | 明示不可恢复、列出将级联删除的子代理会话数量与占用空间；**只在会话确有在跑的工作时**才需要先停止 |

**「在跑的工作」≠「进程里还留着这个会话」**：官方 session store 会保留打开过的会话实例，
一个已归档、完全空闲的会话也可能是 resident。插件只把**真正在跑的工作**
（进行中的回合 / 运行中的子代理 / 后台任务 / 定时提醒）当作阻断条件，并把这些工作列在对话框里，
提供**「停止并删除」**（等价于官方「停止并归档」的停止路径：`workspace/session-stop`）。
resident 但空闲的会话直接可删。

子代理会话（`origin: 'subagent'`）会随其父会话一起删除；**分叉出来的会话不会被牵连**
（分叉会话没有 `origin: 'subagent'`，只有 `parentSession`）。

## 安装

本插件是一个标准 DSH bundle（`dsh.bundle.patch` + `dsh.client` 双半包）。

**方式一：在图形界面里安装（推荐，profile 由应用托管时唯一受支持的方式）**

设置 → 插件 → 安装 bundle，目标填本目录的绝对路径：

```
D:\sysdir\Documents\deepseek-harness-workspace\dsh-session-delete-ui
```

**方式二：手动接入 profile（本仓库当前采用的方式）**

`desktop` profile 被 Electron 应用独占，`dsh plugin --profile desktop` 会被拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。手动接入等价于
`install_bundle` 的两步：

```powershell
# 1. 在 profile 的 node_modules 里建立软链（hoisted 布局，直接 junction 即可）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-delete-ui" `
  -Target "D:\sysdir\Documents\deepseek-harness-workspace\dsh-session-delete-ui"

# 2. 在 profile 的 package.json 里登记依赖 + bundle
#    dependencies: "dsh-session-delete-ui": "link:D:/.../dsh-session-delete-ui"
#    dsh.profile.bundles: 追加 "dsh-session-delete-ui"
```

应用会**实时重组** profile：保存 `package.json` 后无需重启，Host 半立即挂载
（可访问 `GET /session-delete/api/health` 验证）。浏览器半需要页面刷新一次才能加载新的模块行。

安装不写入 `cordis.patch.yml`：挂载行由包内的 `cordis.patch.yml` 随 bundle 层生效。

## 工作原理

### Host 半（`index.js`）

注册同源 JSON 路由：

| 路由 | 作用 |
|---|---|
| `POST /session-delete/api/preview` | 只读预检：是否已无记录、**active（在跑的工作）** 与 **resident（进程内仍驻留）**、活动工作清单、日志目录、占用空间、级联子代理列表 |
| `POST /session-delete/api/delete` | 执行删除；`stopActivity: true` 时先走官方停止路径；返回 `deleted / skippedActive / missing / failed` 明细 |
| `GET /session-delete/api/health` | 挂载自检（返回 sessions 根目录、持久化服务可用性、存活会话数） |

删除顺序（**先文件、后账目**，任何失败都不会留下「已隐藏但没删掉」的半删状态）：

1. **活动判断**：用 Harness 自己的归档准入问题
   `ctx.waterfall('workspace/session-activity', …)` 取工作族（turn / job / subagent / schedule，
   与官方「停止并归档」用同一套 provider）；有工作且未要求停止 → 409 `active`，
   要求停止则 `ctx.parallel('workspace/session-stop', …)` 后短暂等待收敛，仍不收敛 → 409 `still-active`。
   **`ctx.sessions.get(id)` 只用来报告 resident，不再作为拒绝依据**；
2. **定位**：通过 `ctx.sessionPersistence.list()` 取全部 header，再用后端的 `locate(header)` 得到绝对路径；
   退化路径是扫描 `<sessions>/<project>/<id>`；
3. **路径校验**（`assertRemovable`）：必须是 `<sessionsRoot>/<project>/<id>` 恰好两段、目录名等于会话 id、
   不是符号链接/junction、realpath 后仍在 sessions 根内 —— 校验通过才进入删除；
4. `rmSync(目录, { recursive: true })` 删除日志目录；
5. 删除 `~/.dsh/storages/session_projcache/sessions/<id>.json`；
6. 工作区账目：`unpinSession` / `detachSession`（仅显示与记账，失败只记日志）；
   **resident 会话保留归档标记**——归档闸门正是阻止内存里那个实例往已删除目录重新写日志的开关；
   冷会话则照常 `unarchiveSession` 清账。

子代理级联由 header 的 `origin === 'subagent'` + `parentSession` 推导，深度上限 6 层。
比较 id 时同时接受带与不带 `session-` 前缀的写法（DSH 两种都在用）。

### Client 半（`client.js`）

`window.__ModuleLoader__.load({ id, factory })` 形式的浏览器 bundle，**只用官方 Slot 扩展点**：

- `sidebar.workspaces.session.menu.item`（`order: 500`）→ 菜单项「删除会话」；
- `shell.overlay` → 确认对话框与结果提示。

删除成功后调用 `ctx.get('sessions').refresh()` 让会话目录重新拉取，行随即消失，无需刷新页面。
样式从官方 primitives 的 `Menu.module.css` / `Modal.module.css` / `Button.module.css` 复制后改名为
`dsd_` 前缀，只引用 `--dsw-alias-*` 主题 token，因此亮/暗主题自动跟随。

不 `require` 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-*`），只用浏览器模块表里的 `react`。

## 安全设计

- **双重确认**：菜单项 → 确认对话框；对话框中的删除按钮在预检完成、且会话可删时才会启用；
- **只在有活时拦截**：有在跑的工作时列出工作族并走「停止并删除」；resident 但空闲的会话不再被误判；
- **路径围栏**：删除前逐项校验路径，绝不跟随符号链接离开 sessions 根；
- **级联有界**：只级联 `origin: 'subagent'` 的子会话，分叉会话不受影响；
- **先删文件后改账目**，失败时行保持可见并把原因回给对话框。

## 验证

已执行（本机实测）：

| 检查 | 结果 |
|---|---|
| Host 行为测试 `node test/host-behavior.test.mjs` | **27/27 通过**：真实 sessions 根只读预检 + 隔离夹具上的真实删除与级联；**resident 空闲可删 / 有活拒绝 / 停止后放行 / resident 保留归档闸门 / 冷会话清归档 / 路径穿越拒绝 / 重复删除 404** |
| Client 渲染测试 `node test/client-render.test.mjs` | **42/42 通过**：模块注册、两个 slot 的 id/order/locale、菜单项与对话框渲染、活动工作清单与「停止并删除」、resident 提示、旧版 Host 半的降级提示、确认→刷新→提示、失败保留对话框、缺失 locale 仍可渲染 |
| 运行中的应用（Host） | Host 已挂载：`GET /session-delete/api/health` → 200 |
| 真实路由 | 普通会话 preview → `deletable: true` 并给出真实目录与体积；有活会话 `delete` → 409 |
| 浏览器 Bundle | 按 `dsh-client-modules` 的 rev 规则计算 combo URL 后请求 → **200**，说明模块图已包含本插件的行 |

> **改完 Host 半需要重启 DSH**：DSH 的插件 JS 是「一个进程一份模块代」，改了 `index.js` 后运行中的进程仍跑旧代码
> （实测：改完后路由仍返回旧的 `live` 字段）。浏览器半会随文件变更重新下发，两个半版本不一致时，
> 对话框会明确提示「Host 半需要重启 DSH」，不会把旧版的误判当成结论。

**尚未验证**：浏览器里的视觉呈现（本会话没有浏览器控制能力）。菜单项与对话框的实际外观请在页面中确认；
若菜单里暂时看不到，刷新一次页面即可。

## 同类项目调研

动手前先看了 GitHub / npm 上已有的会话删除插件，取长补短：

| 项目 | 做法 | 本插件的取舍 |
|---|---|---|
| [vtxf/dsh-session-delete](https://github.com/vtxf/dsh-session-delete)（npm `dsh-session-delete`） | Host 路由 + `ctx.shell` 执行 `rm`/`Remove-Item`，客户端用 **DOM 注入**克隆菜单项（作者认为菜单没有 Slot） | 保留「Host 路由 + 确认 + 存活拒绝」的思路；**改用官方 Slot**（`sidebar.workspaces.session.menu.item` 在现行版本已开放），并用 `node:fs` 直接删除（无 shell 转义面） |
| [masknull/dsh-delete-session](https://github.com/masknull/dsh-delete-session) | 侧栏「⋯」菜单加「删除会话」，不接管任何官方行 | 同思路，直接落在官方 Slot 上；额外做级联与预检 |
| [liuyu-f/dsh-plugin-session-cascade-delete](https://github.com/liuyu-f/dsh-plugin-session-cascade-delete) | 日志目录 + 投影缓存 + 工作区账目，级联子代理，先停再删，并提供 `session_delete` 工具 | 采纳级联边界（只删 subagent 子会话，分叉不碰）与「先删文件后记账」；工具入口留作后续 |
| [cckbc/dsh-delete-session](https://github.com/cckbc/dsh-delete-session) / [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)（npm `dsh-session-recycle-bin`） | 回收站：先移入回收站，默认保留 15 天，可还原 | 本插件定位是「永久删除 + 对话内确认」；回收站是另一条产品路线，未采用（如需可加 `Config` 开关） |
| [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) | 完整的会话管理器：删除、归档、跨工作区移动、标签、批量操作 | 功能面大；本插件只做单一职责的删除，避免接管官方行 |
| [@linxin666/dsh-session-archive](https://www.npmjs.com/package/@linxin666/dsh-session-archive) | 集中式归档清单、批量归档/还原、物理删除、自动清理策略，含 `node:sqlite` 的 rdb 清理 | 其中「路径必须留在 sessions 根内、realpath 复核」的安全写法被本插件吸收 |

## 已知限制

- **没有回收站**：删除不可恢复（对话框已明示）。需要可恢复请改用回收站类插件；
- **只清理本插件的关注面**：`dsh-cost-meter` 等第三方插件自己的账本不会被清理；
- **级联深度上限 6 层**；
- **改了 Host 半要重启 DSH**：进程内的插件 JS 不会热替换；浏览器半改动需要刷新页面；
- **resident 会话的内存实例**：删除后进程内仍持有该实例（应用重启后释放），所以保留归档闸门防止它再写日志。

## 目录

```
dsh-session-delete-ui/
├── index.js                      Host 半：路由 + 删除实现
├── client.js                     浏览器半：菜单项 + 确认对话框
├── cordis.patch.yml              bundle 挂载行
├── package.json                  dsh.bundle.patch + dsh.client（platform/immediately/inject）
├── icon.svg / locale/{zh,en}.json  插件管理器卡片
└── test/
    ├── host-behavior.test.mjs    Host 行为测试（27 项）
    └── client-render.test.mjs    Client 渲染测试（42 项）
```

## License

MIT

---

<a id="english"></a>
## English

A DSH (DeepSeek Harness) plugin that adds the missing **Delete session** action to the sidebar
session row menu (`sidebar.workspaces.session.menu.item`, order 500, its own danger group) plus a
confirmation dialog in `shell.overlay`.

The shipped Harness has no deletion API, so the Host half performs that out-of-band maintenance:
it refuses only **running work** (turn / subagent / job / schedule, asked through the Harness's own
`workspace/session-activity` waterfall and stoppable through `workspace/session-stop`), resolves the
artifact through `ctx.sessionPersistence`, validates the path (exactly `<sessionsRoot>/<project>/<id>`,
never a symlink, still inside the real root), removes the log directory and the projection cache, and
only then drops workspace accounting. A session that is merely still resident in the process — an
archived, idle session, for example — is deletable; it keeps its archive gate so the in-memory
instance cannot write a fresh log into the directory just removed. Subagent descendants cascade;
forked sessions never do. Files first, bookkeeping second.

Verified locally: 27/27 host checks (real read-only planning + destructive run on an isolated
fixture, including resident-idle, running, stop-then-delete, and archive-gate cases), 42/42 client
checks (registration, rendering, guards, confirm flow), the live Host route
(`GET /session-delete/api/health` → 200, live session delete → 409), and the served browser bundle
(combo URL computed from `dsh-client-modules`' revision rule → 200). Visual appearance in the page
was not verified: this session has no browser control.
