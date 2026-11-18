# vipper

vipper 是 Chrome MV3 扩展：标签管理器 + 书签/密码管理器。本词汇表收录项目特有的领域术语，供所有开发会话统一口径。

## Language

**Vault（保管库）**:
vipper 的加密书签/记录库，数据只存在于扩展自身存储中，解锁后方可读取敏感内容。锁库即不可读。
_Avoid_: 数据库、仓库（repository）

**host（`vipper-host`）**:
本地 Native Messaging 程序，外部应用与扩展之间的唯一通道。愚蠢管道：不持有密钥、不做决策。
_Avoid_: daemon、后端、服务（"服务"容易暗示它持有数据，它不持有）

**client（`vipper-cli`）**:
命令行客户端，外部应用与 host 之间的唯一适配器。
_Avoid_: CLI 工具之外的叫法

**配对（pairing）**:
客户端首次连接时的登记握手，必须由用户在扩展弹窗中亲手确认。未配对的客户端拿不到任何数据。
_Avoid_: 注册、登录、认证（authentication）

**客户端身份**:
配对时确立的长期身份 = 客户端公钥指纹 + 用户起的名字。与进程属性（exe 路径、PID）严格区分：后者只用于展示与审计，永远不作安全锚点。
_Avoid_: 进程名、可执行文件路径（这些不是身份）

**令牌（token）**:
一次授权通过后签发的访问凭证，绑定「客户端身份 + 具体条目 + TTL」。有过期；身份没有过期。
_Avoid_: 会话（session）、密钥（key）

**三态开关（socketExposure）**:
一条私密记录对 socket 的暴露策略：⛔禁止（默认）/ 🔔每次询问 / ✅允许指定客户端。
_Avoid_: 权限位、开关（裸用）

**条目路径**:
socket 寻址格式 `<书签title>/<secret记录name>`。书签 title 全局唯一、secret name 书签内唯一，因此路径至多命中一条。
_Avoid_: 条目名、ID（寻址不用内部 id）
