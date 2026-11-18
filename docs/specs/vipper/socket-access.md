# vipper 外部访问接口（socket API）设计文档

> 版本：v2.0 · 日期：2026-11-18 · 状态：设计定稿（Q1–Q17 质询确认）
> 目标读者：vipper 项目开发者
> **本文档是 socket 功能的唯一事实源**（Q4）。早期讨论稿曾存放在 dsh-arch-helper-plugin 仓库，仅作历史讨论记录，自本文档起两者无关、不再同步。
> 前置背景：vipper 是 Chrome MV3 扩展（WXT + TypeScript），目前加密保管库只能服务浏览器内场景（书签/账号/私密记录）。本设计让系统环境中的外部应用（dsh、shell、git、msmtp 等）也能安全地读取 vipper 中的私密信息，同时守住两条核心原则：**私密信息不明文落盘、使用过程中不明文显示**。

---

## 1. 目标与非目标

### 目标
- 外部应用可通过本机 IPC 通道，按条目精确读取 vipper 中的私密记录（`secret.content`）。
- 全过程不经用户许可不可读：配对需亲手确认、取密钥按条目过策略。
- 一切访问留痕可审计。
- Linux / macOS / Windows 三平台架构兼容（Linux 先行落地）。

### 非目标
- 不做写接口（外部应用只能读，不能改保管库）。
- 不做 list-all / 搜索接口（客户端必须知道条目路径才能取，寻址规则见 §6.2）。
- 不解决"同用户恶意进程 ptrace 读内存"这一 OS 层面无法完美防御的模型（见 §12 残余风险）。
- **不拆 vault 内核出浏览器**（Q10 确认方案 A）。方案 B（独立后端 daemon 持有 vault，浏览器插件与 cli 同为客户端）记为**方向性备选**，触发条件 = 出现"不开浏览器也要取密钥"的真实刚需场景（如 TTY 登录、SSH 进本机、开机即跑的邮件同步）；届时演化为 B 的路径是 host 从愚蠢管道长肉成真 daemon，M40–M43 的协议层投资（配对/授权/审计/cli 四模式）可复用。

---

## 2. 术语表

术语的权威定义见仓库根目录 [GLOSSARY.md](../../../GLOSSARY.md)。本设计核心术语：

| 术语 | 定义 |
|---|---|
| **vault** | vipper 的加密保管库，仅存于扩展内；密钥在 `chrome.storage.session`，锁库即销毁 |
| **host** | `vipper-host`，本地 Native Messaging 程序，socket 监听者与消息转发管道 |
| **client** | `vipper-cli`，命令行客户端，外部应用与 socket 之间的唯一适配器 |
| **配对（pairing）** | 客户端首次连接时的登记握手，需用户在扩展弹窗中亲手确认 |
| **客户端身份** | 配对时生成的 X25519 公钥指纹 + 用户起的名字；私钥存客户端本地 0600 文件 |
| **令牌（token）** | 授权通过后签发的访问凭证：绑定「客户端身份 + 具体条目 + TTL」，存 `chrome.storage.session` |
| **三态开关** | 私密记录的 socket 暴露策略：⛔禁止（默认）/ 🔔每次询问 / ✅允许指定客户端 |

---

## 3. 总体架构

```
外部应用（dsh / git / msmtp / 任意脚本）
        │  ① 四种消费模式之一（§9）
        ▼
vipper-cli ──（本机 IPC：unix socket / named pipe）──▶ vipper-host
        │                                               │  stdio
        │                                               ▼
        └──────── ② 配对握手 · ③ 策略检查 · 弹窗确认 · 审计
                                              vipper 扩展（service worker）
                                              唯一的解密者与决策者
```

职责划分：
- **vipper 扩展**：唯一持有解密密钥；配对确认、授权策略、弹窗、审计全部在此。host 拿不到任何明文。
- **vipper-host**：**愚蠢管道**——只做三件事：校验对端 UID、逐帧转发字节（不解析帧内容，见 §4.3）、记录连接元数据。不持有密钥，不做策略决策。
- **vipper-cli**：万能适配器，把 socket 协议封装成四种消费模式（§9），是外部应用唯一需要打交道的东西。

### 代码布局（Q1）

host 与 cli 在 **vipper 仓库内**，仓库改造为 pnpm workspace：

```
vipper/
├── package.json            ← 扩展（WXT），现有
├── packages/
│   ├── vipper-host/        ← Native Messaging host
│   └── vipper-cli/         ← 命令行客户端
```

理由：socket 协议两端（扩展内协议层 + host/cli）强耦合、必须同步演进；同仓单 spec 保持"变更事实源唯一"。

---

## 4. 传输层设计（跨 OS）

host 定义平台无关的传输层接口，协议层（配对、授权转发、审计）完全建立在接口之上，不感知平台差异：

```typescript
interface Transport {
  listen(path: string, onConnection: (conn: Connection) => void): Promise<void>;
  // ...
}
interface Connection {
  getPeerInfo(): PeerInfo;   // { uid, pid, exePath } —— 平台各自实现
  send(msg: Buffer): void;
  recv(): AsyncIterable<Buffer>;
  close(): void;
}
```

两个实现：

| | unix-socket 实现（Linux / macOS） | named-pipe 实现（Windows） |
|---|---|---|
| 监听地址 | `$XDG_RUNTIME_DIR/vipper/host.sock`（Linux，0700 tmpfs）；macOS 用 `$TMPDIR/vipper/host.sock` | `\\.\pipe\vipper` |
| 对端凭据 | Linux `SO_PEERCRED` → 真实 PID/UID/GID，再读 `/proc/<pid>/exe` 得 exe 路径；macOS `getpeereid()` / `LOCAL_PEERCRED` | `GetNamedPipeClientProcessId()` |
| 文件权限 | socket 文件 chmod 0600 | pipe ACL 限定当前用户 |
| 实现要点 | Node `net` 模块原生支持 | Node `net` 模块同名 API（传 pipe 路径自动区分）；对端 PID 需原生 addon 或兜底调用系统命令 |

传输层强制规则：
1. `getPeerInfo()` 返回的 **UID ≠ 当前用户 → 立即拒连**（挡住其他用户）。
2. UID 校验只能挡"别的用户"，**挡不住同用户进程**——这是后续配对层/授权层存在的原因。
3. macOS 与 Linux 共用 unix-socket 实现，仅凭据 API 与 socket 目录两行差异；Windows 留接口后补（见 §14 待定项）。

> 选型说明：vipper 已是 TypeScript 技术栈，host 与 cli 用 Node.js 编写复用度最高；`net` 模块对 unix socket 与 Windows named pipe 是同一套 API，传输层抽象成本最低。

### 4.3 帧格式（Q13）

**socket 与 Native Messaging 同构**：Native Messaging 本身就是「4 字节小端长度前缀 + UTF-8 JSON」，socket 侧采用同一种帧格式：

```
┌────────────────────┬──────────────────────────┐
│ uint32 LE 帧长度    │ JSON 消息体（UTF-8）       │
└────────────────────┴──────────────────────────┘
```

- host 因此是字面意义的**愚蠢管道**：逐帧原样转发，完全不解析消息体。
- 配对完成后消息体为**加密信封**（`{"$enc":"v1","iv":<base64>,"data":<base64>}`，复用 vault 既有信封格式），长度前缀保持明文——加密层在帧格式之内，host 依然不需要懂加密。
- 每条消息带 `id`（请求/响应配对，支持多个 socket 连接复用同一 native 端口）与 `v: 1`（协议版本，供将来演进）。

---

## 5. 配对层：客户端登记（亲手确认）

socket 对同用户进程天生不设防，因此**未配对的客户端必须什么都拿不到**。

### 5.1 配对流程

```
1. vipper-cli 首次连接 → 本地生成 X25519 密钥对
   私钥存 ~/.config/vipper/client-key（0600），此后每次连接复用，身份不变
2. cli 发送 pair 请求：{ 客户端公钥, 自报名称, 版本 }
3. 扩展弹确认窗（§7）：显示客户端名称、exe 路径（来自 getPeerInfo）、PID
   「应用 vipper-cli 请求访问保管库，是否允许？」
4. 用户亲手确认 → 扩展记录：{ 公钥指纹, 用户起的名字（如"我的 dsh 插件"）, 配对时间 }
5. 此后全部请求/响应经加密信封传输（X25519 协商出的会话密钥），通道本身保密
```

### 5.2 通道加密算法（Q2，修正原设计）

原设计写的「Curve25519 + NaCl box」**作废**——NaCl box 必须引第三方库（tweetnacl/libsodium），违反项目红线"加解密只用 WebCrypto API，不引入第三方加密库"。改为纯 WebCrypto 自建：

- **X25519（ECDH）** 密钥协商 → **HKDF-SHA256** 派生会话密钥 → **AES-GCM 256** 加密消息体；
- 扩展侧用浏览器 WebCrypto（要求 **Chrome ≥133**，X25519 进入 WebCrypto 的版本）；host/cli 侧用 Node 内置 `crypto.webcrypto`（要求 **Node ≥22**）；
- **M40 第一件事实测两端 X25519 可用性**；若目标环境不可用，降级为 **P-256 ECDH**（其余流程不变），仍不引第三方库。

### 5.3 身份语义（重要）

- **身份不变**：密钥对只在首次配对时生成一次，之后每次连接、每次 get 都用同一身份。只有私钥文件被删、用户撤销、或主动重新配对时身份才变。
- **身份与令牌分离**：身份（密钥对）永久有效直至撤销；令牌（§6.4）有 TTL 会过期，过期后用同一身份续期，白名单条目不受影响。
- **进程属性只做辅助**：exe 路径/PID 用于弹窗展示、变更告警（"该客户端上次路径为 /usr/bin/vipper-cli，现为 /tmp/xx，仍允许？"标黄警示）与审计记录，**不作为安全锚点**——进程名可随手伪造、exe 哈希在滚动发行版上每次升级都变、解释型脚本 exe 是解释器本体，均不可靠。

---

## 6. 授权层：每次取密钥都过策略

配对 ≠ 授权。每个 get 请求到达扩展后按顺序过以下关卡，任一不过即拒绝：

### 6.1 条目级三态开关（新增字段）

私密记录（`records` 中 `template: 'secret'` 的项）新增 `socketExposure` 字段：

| 状态 | 语义 |
|---|---|
| ⛔ `disabled`（**默认值**） | 该条目对 socket 完全不可见，get 返回 `not_found`（不泄露条目存在性） |
| 🔔 `ask` | 每次请求都弹窗询问，可选"仅此一次 / 转为 ✅ 记住此客户端" |
| ✅ `allowed` | 仅允许条目的客户端白名单（存**客户端身份：公钥指纹 + 名字**，非进程名）内的请求直接放行 |

字段缺省视为 `disabled`：既有数据无需迁移，新建记录不会意外暴露。

### 6.2 寻址规则（Q11 + Q15）

- 接口只有 `get(条目路径)`，**不提供 list-all / 搜索**；不知道路径就什么都拿不到。
- **寻址格式 = `<书签title>/<secret记录name>`**（如 `git/github`、`llm/deepseek`）。
- 唯一性约束（由 **M39** 落地，先于 M40 完成）：
  - **书签 title 全局唯一**（active + archived 一起唯一；恢复归档时撞名则拒绝恢复并提示先改名）；
  - **secret 的 name 在所属书签内唯一**（不分状态）；
  - 约束在**所有写入口强制校验**：wui 新建/编辑表单、登录自动保存（`addBookmark`/`saveBookmark`）、全量 JSON 导入、浏览器书签导入（撞名处理细则见 §6.3）。
- 既有数据：**2026-11-18 已检测无重名（199 条，当日备份）**，不做迁移；寻址逻辑仍保留防御分支——若旧数据出现重名（多于 1 个匹配），返回 `ambiguous` 错误并记审计，拒绝服务不猜。
- 解析规则：只扫描 **active** 书签（归档不参与，与 Alt+P 一致）；0 个匹配 → `not_found`；多于 1 个 → `ambiguous`（纯防御，约束生效后不应出现）；恰好 1 个 → 进入三态策略检查。
- vault 锁定时所有请求返回 `locked`，不泄露任何元数据。
- 每次请求弹窗/响应等待 **60 秒超时，默认拒绝**。

### 6.3 自动流程撞名处理（Q17）

两条无法停下来问用户的自动路径，撞名时**自动追加序号后缀**（`淘宝` → `淘宝 (2)`），不阻断流程：

- **登录自动保存**：默认标题 = 标签页标题，撞名自动加后缀保存；
- **浏览器书签导入**（追加语义，不能丢书签）：撞名自动加后缀，结果报告中体现改名数量。

**例外：全量 JSON 导入**是数据恢复语义——文件内含重名 title（或书签内重名 secret name）**直接拒绝导入并报告冲突项**，不修数据，防止带病恢复。

### 6.4 作用域令牌（Q3，修正原设计）

🔔 批准或 ✅ 命中后，扩展签发令牌：`{ 客户端身份, 条目路径, 过期时间 }`。

- **存 `chrome.storage.session`**（不是"扩展内存"）：MV3 service worker 30 秒空闲即被回收，纯内存令牌会在 TTL 内频繁蒸发导致反复弹窗；`storage.session` 默认驻留浏览器内存不落盘、SW 回收不丢、浏览器进程退出即清空——语义恰好等于"浏览器重启即失效"。
- TTL 内同客户端取同一条目免重复弹窗；TTL 默认 8h，可在设置中调整。
- 锁库即清空全部令牌（保留审计）；过期后用同一身份续期。

### 6.5 通用性说明

授权逻辑全部在扩展端实现，**请求方软件零参与**：dsh 这类"聪明"软件直接调 socket/cli；"笨"软件通过 vipper-cli 的四种消费模式（§9）间接使用。一套授权逻辑服务所有客户端形态。

---

## 7. 确认窗与扩展端改动

确认交互**不需要新增大页面**，采用 `chrome.windows.create` 独立小窗（MetaMask 签名确认同款模式）：

```
┌─────────────────────────────────────┐
│ vipper 访问请求                      │
│ 客户端: vipper-cli (/usr/bin/…)     │
│ PID:    8123                        │
│ 请求:   llm/deepseek（私密记录）     │
│ [ 仅此一次 ] [ 记住此客户端 ] [ 拒绝 ] │
└─────────────────────────────────────┘
```

技术要点（MV3 约束）：
1. toolbar popup 无法被代码强制打开，确认窗必须用 `chrome.windows.create({ type: 'popup', focused: true })`，可由 service worker 随时拉起。
2. **不用 `chrome.notifications`**：按钮不可靠、易自动隐藏，安全问题必须等到真实回答。
3. **service worker 会被 Chrome 回收**：待确认请求先落 `chrome.storage.session`（Q3，与令牌同一存储），确认窗从那里读取，请求不丢失。

管理页仅需三个小改动：
- 私密记录编辑表单：`socketExposure` 三态选择器（⛔/🔔/✅ + 客户端白名单编辑）
- 新小节「已配对客户端」：查看/重命名/撤销（撤销即删除身份并清空其全部令牌）
- 新小节「审计日志」：见 §8

---

## 8. 审计层：一切留痕

每个请求记录一条审计日志（存扩展本地 `chrome.storage.local`，条数上限可配，如 1000 条滚动）：

```
{ 时间, 客户端身份(指纹+名字), exe 路径, PID, 条目路径,
  结果: granted / denied / locked / timeout / not_found / ambiguous }
```

要求：管理页可回放查看；审计条目只增不改；vault 锁定期间清空令牌（§6.4）但保留审计。

---

## 9. vipper-cli：四种消费模式（使用文档的推荐顺序）

命令名统一为 **`vipper-cli`**（Q12，修正原设计中模式 4 的 `vipper run` 写法）。使用文档必须按以下优先级说明，**越靠前越安全**：

### 模式 1：应用直接调 socket API（★★★★ 安全 / 需应用有能力）
软件有插件/源码能力时，直接走 socket 协议（或封装 `vipper-cli get`），密钥只进应用内存。
**dsh 适用**：dsh 有 `CredentialProvider` 服务抽象（本机实现为 `dsh-credentials-local`，从 owner-only 的 YAML 凭据文件读取，环境变量兜底）——可开发 dsh 插件实现 CredentialProvider，会话内调 vipper 取 key，密钥只活在 dsh 进程内存。

### 模式 2：密码命令模式（★★★★ 安全 / 通用性被低估）
目标软件支持"执行命令获取密钥"类配置时优先用：
- git：`credential.helper '!f() { echo password="$(vipper-cli get git/github)"; }; f'`
- msmtp：`passwordeval "vipper-cli get smtp/gmail"`
- restic：`--password-command`、offlineimap/mutt 等同类

密钥从 cli stdout 直接进应用堆内存：不进 environ、不遗传子进程、用完可清零。
**注意：dsh 没有密码命令模式**——其凭据解析为「本地 YAML 凭据文件 → `apiKeyEnv` 指定的环境变量」两级，dsh 场景请用模式 1 或模式 4。

### 模式 3：fd / 临时文件注入（★★★ / 通用）
`app --key-file <(vipper-cli get x)`：进程替换生成 memfd，不落盘；适合支持"从文件读 key"的软件。

### 模式 4：`vipper-cli run -- app` env 注入（★★ / 兜底但最通用）
启动时把密钥注入目标进程环境变量，进程退出即消失、不进用户 shell。
**必须在使用文档中写明代价**：env 位于 `/proc/<pid>/environ` 公开接口，同用户进程一条 `cat` 可读；自动遗传给所有子进程；伴随进程终身。仅用于不支持前三种模式的软件。

---

## 10. 安装、分发与版本底线

### 10.1 扩展 ID 固定（Q5）

- `wxt.config.ts` 给 manifest 钉固定 `key`：未钉 key 的 unpacked 扩展，加载路径/机器不同 ID 都会变，`allowed_origins` 无从固定。钉 key 后 dev 与正式加载同 ID。
- **注意**：钉 key 会改变现有安装实例的扩展 ID，需重新加载一次扩展（数据在 `chrome.storage.local`，不受影响）。

### 10.2 host 安装（一次性）

`scripts/install-host.sh` 一次性完成：
1. 复制 host 程序到 `~/.local/lib/vipper/vipper-host`；
2. 写 Native Messaging manifest `com.vipper.host.json` 到 **Chrome 与 Chromium 两个路径**（`~/.config/google-chrome/NativeMessagingHosts/` 与 `~/.config/chromium/NativeMessagingHosts/`），内容为 host 路径、`"type": "stdio"`、`allowed_origins` 仅含钉死的扩展 ID；
3. 检查 `node --version` ≥ 22，不满足则明确报错退出（Q14）。

安装只需一次；之后扩展调用 `chrome.runtime.connectNative()` 时 Chrome 自动拉起 host 进程，host 空闲即退出，无常驻守护进程。

### 10.3 cli/host 分发（Q8）

release workflow 增加一个打包 job：产出 **`vipper-host-cli-<version>.tar.gz`**（host + cli + `install-host.sh`），与扩展 zip（`vipper-<version>.zip`）挂**同一个 GitHub Release**。版本事实源不变（`package.json` 经 release-please），同一个 tag、两个产物；tarball 为纯 JS + shebang，不打包 Node 本体。

### 10.4 版本底线（Q14）

| 组件 | 底线版本 | 原因 |
|---|---|---|
| Chrome | ≥ 133 | WebCrypto X25519（§5.2） |
| Node.js | ≥ 22 | `crypto.webcrypto` X25519（§5.2） |

---

## 11. 安全设计清单（验收必查）

- [ ] Native Messaging manifest 的 `allowed_origins` 只含钉死 `key` 后的 vipper 扩展 ID（§10.1）
- [ ] socket 位于 `$XDG_RUNTIME_DIR`（0600），UID 不符拒连
- [ ] 未配对客户端任何请求返回统一错误，不泄露 vault 状态
- [ ] 配对、🔔 授权必须真人弹窗确认；超时默认拒绝
- [ ] 条目默认 ⛔（字段缺省即 disabled），新建记录不会意外暴露
- [ ] 无 list-all 接口；`not_found` 不区分"不存在"与"⛔禁止"；重名旧数据返回 `ambiguous` 不猜
- [ ] 令牌存 `chrome.storage.session`、带 TTL；锁库即清
- [ ] 待确认请求存 `chrome.storage.session`，SW 回收不丢
- [ ] 审计日志完整覆盖 granted/denied/locked/timeout/not_found/ambiguous
- [ ] cli 收到密钥写 stdout 后即清零内存
- [ ] 通道加密为 WebCrypto X25519+HKDF+AES-GCM（或降级 P-256），无第三方加密库
- [ ] `install-host.sh` 校验 Node ≥22；Chrome 侧要求 ≥133

### 11.1 锁定边界（Q9）

- **不启用 Chrome 后台运行模式**（"关闭 Google Chrome 后继续运行后台应用"保持关闭）。
- 锁定边界 = **浏览器进程退出**：关闭最后一个窗口即退出 Chrome 进程，`chrome.storage.session`（密钥、令牌、待确认请求）随之清空，vault 锁定。
- 后台模式下"关闭所有窗口不锁定"的问题在本设计不成立，其成因（后台模式令 Chrome 进程常驻）已通过不启用该模式排除。

---

## 12. 残余风险（写进文档，不隐瞒）

1. **ptrace**：同用户恶意进程在 Linux 上可 ptrace 读任意进程内存（除非开 `kernel.yama.ptrace_scope` 加固）。
2. **浏览器必须运行**：方案 A 的固有代价——浏览器进程不在时 socket 服务不存在，外部应用取不到密钥（host 由 Chrome 拉起）。若此约束成为真实痛点，即触发方案 B 的重新评估（见 §1 非目标）。

本设计的目标是：① 杜绝意外泄露；② 新客户端必须经用户亲手同意；③ 泄露可发现可追溯；④ 暴露窗口最小化（TTL、锁库、内存即弃）。达到①–④即与 KeePassXC / 1Password 本地模型同水位。

---

## 13. 里程碑拆分

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M39 唯一性约束**（前置，Q15/Q16/Q17） | 书签 title 全局唯一（active+archived）、secret name 书签内唯一；写路径强制校验（wui 表单、登录自动保存、浏览器书签导入、JSON 导入）；自动路径撞名加 ` (2)` 后缀；全量 JSON 导入含重名拒绝；wui 编辑表单保存重名时内联报错（不丢输入） | 各写入口重名拒绝有明确错误；自动路径撞名自动改名且有报告；存量 199 条无重名不受影响 |
| **M40 传输层 + host 骨架** | pnpm workspace 改造；Transport 接口 + unix-socket 实现（Linux）、SO_PEERCRED、帧格式（§4.3）、Native Messaging 接通扩展；**首验 X25519 两端可用性**（不可用降级 P-256）；manifest 钉 key；install-host.sh | Linux 上 cli→host→扩展字节互通；异 UID 连接被拒；node 版本检查生效 |
| **M41 配对层** | X25519 配对握手、确认窗、配对存储、X25519+HKDF+AES-GCM 加密通道 | 未配对请求全拒；弹窗确认后通道加密可用；删私钥文件需重新配对 |
| **M42 授权层** | `socketExposure` 三态字段、白名单、寻址规则（§6.2）、令牌 TTL（storage.session）、60s 超时默认拒绝、🔔 弹窗 | 三态行为全部符合 §6；令牌过期续期身份不变；SW 回收后令牌不丢 |
| **M43 cli 四模式 + 审计** | `vipper-cli get` / `vipper-cli run` / fd 模式、审计日志与管理页两小节、release tarball job | git/msmtp 实战通过；审计可回放；release 产出双产物 |

---

## 14. 跨 OS 与待定项

跨 OS 兼容矩阵（目标架构）：

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 扩展 ↔ host（Native Messaging stdio） | ✅ | ✅ | ✅（注册表注册） |
| host 对外监听 | unix socket | unix socket | named pipe |
| 对端凭据 | SO_PEERCRED | getpeereid/LOCAL_PEERCRED | GetNamedPipeClientProcessId |
| socket 目录 | `$XDG_RUNTIME_DIR` | `$TMPDIR` | 无（pipe 命名空间） |
| 交付优先级 | P0 | P1 | P2 |

**待定项**：
- **M5 跨 OS**（macOS 凭据 API 适配、Windows named-pipe 实现）：Linux（M40–M43）跑通前不动，挂起为待定。
- **方案 B**（独立后端 daemon）：方向性备选，触发条件见 §1 非目标。

---

## 15. 附：与 dsh 集成的结论速查

- dsh 凭据解析：`apiKeyEnv` 配置项命名一个环境变量；`dsh-credentials-local` 从 owner-only YAML 凭据文件读取并优先于启动环境。
- dsh **无密码命令模式**。
- 推荐路径：dsh 插件实现 `CredentialProvider` 调 vipper（模式 1）；过渡路径：`vipper-cli run -- dsh`（模式 4，注意 env 风险）。
