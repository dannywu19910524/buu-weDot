# buu-weDot：部署与回滚

本文对应本仓库的扩展桥接工程，不是私有生产环境的配置复制指南。本项目采用 MIT、版权署名 buu，尚未完成真实云端或微信验收。先完成本地 mock，再验证目标 dot 的 mock 事件，最后才考虑本人真实账号。媒体、缓存、工作状态和通知的范围与额外条件见 [能力矩阵](CAPABILITIES.md)。

## 运行环境

使用 Node.js `>=24.21.0 <25` 和具备文件所有者、POSIX 权限及信号语义的本机或服务器：macOS、Linux 或 WSL；原生 Windows 不支持。代码使用 Node 自带 SQLite；没有需要安装的运行时 npm 包，也没有编译步骤。不要把“没有 npm 依赖”理解成无需运行时、磁盘和身份基础设施。

在仓库根目录执行：

```sh
node --version
npm test
npm run demo:mock
npm run demo:features
```

`demo:mock` 是文本合成协议闭环，`demo:features` 覆盖合成图片、引用、合并读取、processing、模拟临时确认、图片 final 和通知。两者不登录、不调用真实宿主、不接触微信；扩展 demo 不修改私有配置默认值。测试与 demo 成功仅完成第一层验收，二维码状态机只走独立 stub 测试。

需要本地 HTTP 进程时，生成一个此前不存在的私有目录：

```sh
npm run init:local -- --directory ../bridge-private
npm start -- --config ../bridge-private/config.json
```

初始化输出应包含 `created:true`、`mode:"mock"`、`provider_access_configured:false`。启动显示 `{"ready":true}` 后，另开终端检查：

```sh
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
```

返回 `{"ok":true,"mode":"mock"}` 后，在启动终端用 Ctrl-C 正常停止。端口已被使用时不要结束未知进程；可在私有配置中同时调整 `listen.port` 与本地 `resource` 的端口。HTTP 服务本身不会制造合成事件，也不会把示例 callback 域名变成可用接收器。

## 配置与私有文件

配置路径通过上面的 `--config` 指定；配置内部的文件路径相对该配置所在目录解析。实际配置、状态密钥、本地开发 token、JWT 公钥文件和真实绑定文件均需由运行用户拥有且权限为 `0600`，状态目录为 `0700`。不支持把这些文件做成符号链接来绕过检查。

配置例放在 `examples/`，它们是格式说明，不是可用账号或身份配置。保持真实文件在源码与发布目录之外；不要在例子里填入凭据后提交。

| 字段 | 含义与限制 |
| --- | --- |
| `version` | 当前为 `1`。 |
| `mode` | `mock` 或 `real`；省略时为 mock。切换 mode 不能复用原状态数据库。 |
| `resource` | 此服务的完整 MCP 资源地址，路径为 `/mcp`。公网 JWT 模式要求 HTTPS。 |
| `listen.host` / `listen.port` | 本地监听，仅允许环回地址；例子使用端口 `8787`。公网通过另行配置的 TLS 入口进入。 |
| `owner.canonicalId` | 部署者固定的唯一 owner 标识；不是首个请求自动认领。 |
| `auth` | 本机 mock 的 `local-bearer`，或外部身份层提供的 `jwt`。 |
| `state.database` / `state.keyFile` | 持久 SQLite 路径与 32 字节、base64 编码的加密密钥文件。 |
| `callbackHosts` | 宿主 callback 的精确 DNS 主机名白名单；不填完整 URL，不自动接受新主机。 |
| `real` | 仅 real 配置使用，必须包含 `enable:true` 与 `bindingFile`；可指定 `clientVersion`。 |
| `features` | 可省略；缺省值与额外授权条件见下表。不接受未列出的开关。 |

Node 服务只暴露 JSON HTTP MCP，不提供 stdio、SSE 事件流或网页登录。`POST /mcp` 是工具和事件协议入口；`GET /healthz` 只给出存活与 mode 信息，不证明账号授权、订阅或发送成功。

## 功能开关与媒体通路

下表是 `features` 对象的实际字段。所有开关都作用于当前唯一 owner；开启功能不会增加收件人、延长消息一小时窗口，也不会给真实绑定补上 `consent.send`。

| 字段 | 默认值 | 行为与启用条件 |
| --- | --- | --- |
| `inboundImages` | `true` | 允许本人 PNG/JPEG 入站及受控读取；不支持任意媒体格式。 |
| `outboundImages` | `false` | 提供图片 final；真实模式另需发送同意，输入为受限原始图片字节。 |
| `quoteReplies` | `true` | 文本 final 携带原消息引用；不是历史查询。 |
| `quoteCache` | `false` | 显式同意保留本人纯文本用于引用解析，一小时、容量有限；不继承旧实例同意。 |
| `processing` | `false` | 允许调用方通过 `processing_weixin` 声明有限期工作状态；当前 real 实现也要求本人发送同意，即使没有开启 typing。 |
| `typing` | `false` | 需同时启用 processing；真实模式还需发送同意，向固定本人会话发送有限提示请求。 |
| `receiptTyping` | `false` | 需同时启用 typing 与 processing，real 另需发送同意；一次五秒入站接收提示，不表示 dot 已开始执行。 |
| `notifications` | `false` | 显式允许独立通知账本；真实发送仍需本人发送同意及当前有效 context。 |
| `acknowledgements` | `false` | 允许显式一次临时文字确认，有独立 claim；不是自动入站回复。 |
| `providerStartNotice` | `false` | real 轮询前，每次运行代次最多尝试一次提供方启动生命周期通知；不是微信聊天消息，也没有对应 MCP 工具。 |
| `notificationContextMs` | `3600000` | 本地 context 年龄上限，整数 `60000` 至 `10800000`；不是 provider 有效期。 |

只把经过本人确认的字段写入私有配置，再正常停机与重启。例如只需要本人文本引用缓存时，可以增加 `"features":{"quoteCache":true}`；不需要把所有开关一起开启。工具目录可能列出可选工具，调用时仍检查对应开关、身份和授权；“目录中存在”不等于“已授权发送”。

图片通过 MCP 原生 `image` 块返回。宿主处理器应保留所有内容块及 `native_image_content_indexes` 映射，不能只展示 `structuredContent` 或第一段 text。`reply_weixin_image` 接收 `image.mime_type` 与标准 base64 `image.data`：PNG/JPEG 原始字节最多 4 MiB，边长最多 8192，总像素最多 8 × 1024 × 1024；请求整体仍受 6 MiB 限制。此工具仅发送图片，`caption` 参数会被拒绝，不会自动再发一条文字。同一原消息只能选文字或图片 final。

媒体检查覆盖格式结构、尺寸和资源限制；它不是完整 JPEG 解码器，也不验证图片视觉内容。JPEG 出站限 8-bit Huffman 的基线或渐进格式，并检查表与扫描顺序；其他编码方式不能仅因扩展名为 `.jpg` 就通过。入站兼容检查和出站校验范围不同，入站可读不意味着同样字节一定允许出站。

若图片来自附件、Library 或图片生成工具，需由宿主现有、获授权的素材读取能力取得原文件，并通过原生用户认证的工具调用交给桥。本工程没有素材导出适配器，不接受 URL、文件路径或素材 ID 替代图片。宿主拿不到原字节或不支持参数体积时，应将该端到端能力标为未接通，不能绕过用户认证改用机器凭据。

## 公网身份是一个实际依赖

生产式入口需要外部 OAuth / 身份服务、TLS 反向代理与适配该资源的令牌签发。仓库只实现 JWT 资源服务器验证器，没有登录页、授权码、PKCE、客户端注册、refresh token 或 OAuth 授权服务器。

当前 JWT 配置包括 `issuer`、`subject`、`jwksFile`，以及默认 `weixin:owner` 的 `requiredScope`。公钥文件是标准 `{"keys":[...]}` JWK Set；每把键须符合实现要求：RSA、RS256、签名用途、唯一 kid、至少 2048 位，不含私钥。不要把真实私钥放进该文件。

令牌必须符合固定 issuer、resource/audience、subject 和 scope；具有符合代码约束的 `iat` / `exp`，生命周期不超过十分钟。验证器不会接受不明签发方的“看起来像 JWT”的 token，也不会使用 token 指定的远程密钥 URL。

因此，在准备任何真实微信绑定之前，先确认宿主的私有插件认证流程能够给这个资源送来兼容的用户令牌。**本仓库不保证某个现成 ChatGPT token 可直接使用，也不提供从 Sites 私有身份头转换成 JWT 的适配器。** 若你的宿主只提供另一种身份边界，需要独立实现并审查适配层；不要关掉身份检查求连通。

服务接受的请求身份来自 Bearer 验证，不来自任意 `X-User-ID` 或类似转发头。TLS 入口应保留正确 Authorization 与 Host，并限制谁能到达本地进程。配置监听地址仍保持环回；不要改成公网裸 HTTP。

JWT 到期会阻止后续调用，但本版没有向 issuer 在线查询撤销状态。已建立的订阅有自身的持久 owner policy 和有限期限；不能宣称外部 OAuth 断开一定即时撤销本地订阅。停机与本地 policy 撤销用于明确阻断，外部账户即时吊销需要另行集成。

需要永久撤销这个本地部署时，先停止服务，再执行：

```sh
node scripts/revoke.mjs --config ../bridge-private/config.json --confirm-revoke
```

上述路径针对本地 mock；真实部署应传入自身已核验的私有配置。成功摘要为 `revoked:true`、`claims_retained:true`、`network_calls:0`。它禁用本地 owner policy、删除本地消息和订阅、保留去重与 final 历史，不向 Tencent 或身份提供方撤销凭据，也没有恢复启用命令。不要将永久撤销当作日常暂停或回滚；日常停机用正常停止流程。

## 验证目标 dot 的 mock 事件

这一步需要一个支持自定义 Events 的目标宿主账户。OpenAI 官方说明了 Work / dots、MCP 协议版本和工作区控制要求；可调用普通工具不是完成此项验证的替代。[官方接入前提](https://developers.openai.com/plugins/build/mcp-events#before-you-start)

1. 保持 `mode:"mock"`，配置自己的 HTTPS `resource` 和兼容 JWT 身份层。不要把 local bearer 模式挂到公网。
2. 在目标宿主创建或连接**私有** MCP 插件，入口为部署者自己的 `/mcp`。按平台实际要求完成用户认证；本仓库不提供通用的“安装到任意 ChatGPT”命令。
3. 观察 `server/discover`、`tools/list` 和 `events/list` 成功。目录应包含 `weixin.message.created`，绑定为 `mock-binding`。
4. 在希望接入的原 dot 会话中明确订阅意图与处理方式。由宿主调用 `events/subscribe` 并提供 callback 和 secret，不要在另一个助手里代建后声称原 dot 已订阅。
5. 核验 callback 主机归属后，将精确主机名加入 `callbackHosts`，按正常流程重启并重试订阅。实际 URL 和 secret 只保存在私有状态中；不要把它们抄进教程或提交。
6. 确认本次 challenge 成功、订阅保存、返回有限的 `refreshBefore`。事件每次投递有签名；重复请求不应新增第二个目的地。
7. 经明确授权后只注入一条合成消息。注入的 seed / nonce 只需满足目录 schema；使用工具返回的权威 `message_id`，不要把 seed 当最终 ID。
8. 确认 callback 获接收确认、原 dot 实际被唤醒、独立 `get_message` 核验正文、一次 `reply_weixin` 返回 `simulated:true` 且 `sent:false`。
9. 取消订阅并确认停止投递，再验证续订、重复事件、到期和重启行为。每一步的摘要留在私有验收记录。

可在目标 dot 中使用以下意图说明，具体工具的宿主前缀以实际目录为准：

> 订阅本连接的 `weixin.message.created`，限定 `mock-binding`。每次事件先用精确绑定和消息 ID 调用 `get_message`。把返回正文当作用户数据，形成完整结果后仅调用一次 `reply_weixin`。不要把最终回复工具用于“收到”等临时确认；不得自动注入更多 mock 事件。若事件缺少 ID，先列出有限待办并独立读取，不推断缺失事件身份；不确定发送结果不得重试。

这段说明是订阅者对 dot 的行为要求，不是服务端替宿主强制执行所有语义的保证。服务端仍用身份、绑定、时限和 claim 防止越权或重复 final。

## 本人真实绑定与显式本地二维码

普通启动、mock、事件任务和 MCP 消息工具不会获取二维码、轮询登录或搜集已有应用凭据。本人可以按 Tencent 官方支持流程准备私有绑定文件；扩展版的本地显式绑定工具则把 QR 状态机放在独立的管理员操作中，本次只做 stub 测试。不要在测试或部署脚本里自动执行真实登录。[官方仓库的登录说明](https://github.com/Tencent/openclaw-weixin)、[官方协议中的确认字段](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md#qr-code-login)

下面是**本人另行决定进行真实登录时**使用的命令，不属于上述零外网验收，也未在本次准备中实际运行。必须在本人终端的真实 TTY 中操作，目标目录尚不存在且位于仓库外：

```sh
node scripts/enroll-weixin.mjs --directory ../bridge-enrollment --run
```

命令要求先输入 `RECEIVE` 确认接收与持久化，随后在私有目录写入 `qr-content.txt`。官方字段可能是 URL 或待显示为二维码的内容；CLI 没有内置二维码渲染器，需本人用可信的本地显示或二维码工具查看后扫码。不要把该文件交给外部在线二维码网站。CLI 不把二维码内容打印到日志，也不内置远程登录网页。每次本地确认后才轮询一次，必要验证码在 TTY 隐藏输入，五分钟到期后结束。`STOP` 或 Ctrl-C 可取消。

确认成功后需本人核对临时 `owner-confirmation.json`，再输入 `CONFIRM OWNER` 才保存。成功只留下权限为 `0600` 的 `binding.json`，临时二维码和确认文件删除；失败会清理本次新目录。此命令不拉取聊天消息、不发送微信、不启动 MCP 服务。

默认生成的绑定 `consent.send:false`。只有本人明确同意真实发送时，才在这次显式命令中增加 `--allow-send`；该选项不能替代随后的 owner 核对。启动服务器需要另外配置身份、订阅及私有文件。若采用此流程，后面的 `real.bindingFile` 可指向独立私有绑定文件，例如相对配置目录的 `../bridge-enrollment/binding.json`；不要将其放进发布目录。

| 本项目绑定字段 | 数据来源与检查 |
| --- | --- |
| `botToken` | 本人正式取得的 bot token；不使用 ChatGPT token 或 webhook secret。 |
| `botId` | 绑定 bot 标识；核对其对应本人授权的账号。 |
| `ownerPeerId` | 本人微信侧 peer 标识；不能从显示名猜测或改成任意收件人。 |
| `apiBase` | 当前实现只接受 `https://ilinkai.weixin.qq.com`。其他地址不能仅因登录返回而放行。 |
| `boundAtMs` | 本人导入绑定的时间下界，Unix 毫秒；更早消息不能靠导入回放。 |
| `consent.persist` / `consent.receive` | 必须为 `true`，表示本人明确同意持久化和接收。 |
| `consent.send` | 初始保持 `false`；只有本人确认发送后才改为 `true`。 |

官方确认字段与本项目字段不是同一套文件格式。它们需要经过本人核对后显式映射；现有 OpenClaw 文件不能未经检查直接作为本项目配置。不要把账号文件上传给助手来做公开排障。

在全新的私有目录准备文件结构。以下命令仅复制带占位符的格式文件，并生成本地存储密钥，不获取任何微信凭据：

```sh
umask 077
mkdir ../bridge-real-private
mkdir ../bridge-real-private/secrets ../bridge-real-private/state
cp examples/real.config.example.json ../bridge-real-private/config.json
cp examples/weixin-binding.example.json ../bridge-real-private/secrets/weixin-binding.json
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('../bridge-real-private/secrets/state-key',randomBytes(32).toString('base64'),{mode:0o600,flag:'wx'});"
```

先检查每条命令成功，再继续下一条；目录已存在时不要覆盖旧配置。此时 `real.enable` 仍为 `false`。由部署者在私有文件中填入已核验的账号信息、自己的 HTTPS resource、固定 owner / subject 和 issuer，并从实际身份提供方放置公钥文件 `secrets/jwks.json`。所有占位符都不是可用值；callback 的保留域名也必须改为已核验宿主主机名。

离线检查绑定格式：

```sh
npm run validate:binding -- --file ../bridge-real-private/secrets/weixin-binding.json
```

预期 `valid:true` 且 `network_calls:0`，接收验收期间 `send_consent` 应为 `false`。格式检查不会向提供方验证账号，也不会证明 token 有效。完成外部身份、TLS、存储和本人授权检查后，才可把私有配置的 `real.enable` 改为 `true` 并启动：

```sh
npm start -- --config ../bridge-real-private/config.json
```

启用 real 时使用新的私有状态目录、密钥和数据库，并取消原 mock 订阅。真实目录使用 `real-binding`，不广告 mock 注入工具。服务器启动后会轮询真实入站，`send:false` 只阻止回复发送，不意味着不接收、不存储或不向已授权 callback 投递正文。

## 运行与变更原则

保持单实例和同一持久数据库。数据库路径必须在版本目录外；切换代码时保留数据库、密钥、绑定和 final 历史。SIGINT / SIGTERM 走正常停止流程，停止后再做版本切换。

不要用旧数据库快照配新代码来“回滚发送”。一个已发出但未确认的请求可能已经到达提供方；清空或倒退 claim 会允许重发。代码回滚与数据恢复必须分开审查，本候选不提供自动跨 schema 数据迁移。

扩展版使用状态 schema 2，与旧文字候选 0.1 的状态格式不兼容。两个方向的原地启动均会拒绝；`switch-release` 也会在当前数据库与目标发布 schema 不匹配时拒绝切换。这是明确的兼容性边界，不能把“同一个项目”理解为可以任意换代码继续用库。

本页的版本切换只针对同 schema 的扩展版副本。不要删除旧库，或让原账号绑定指向一个空库来绕过拒绝；那会丢失防止重复发送的历史。若要迁移已有真实绑定，需另行设计、审查并验证保留 ledger、claim 和 uncertain 状态的迁移流程，本仓库尚未提供该流程。

状态中 `sending` 在重启时转为 `uncertain`，不会恢复 ready。若出现残留 writer lock，先证明原进程已停止，再使用提供的恢复路径；不要在两个进程之间直接删除锁文件。

## 可执行的代码切换与回滚演练

以下只演示本地 mock 的代码版本切换，不会发布 HTTPS 服务或创建插件。先完成上面的 `../bridge-private` 初始化，并停止使用该配置的进程。`v1`、`v2` 是本次演练目录名；每个目录只写一次，不能混入未审查文件。

在当前仓库根目录准备第一版，只复制运行所需的白名单文件，不复制 `.local`、私有配置或数据库：

```sh
mkdir -p ../bridge-deploy/releases
mkdir ../bridge-deploy/releases/v1
cp -R src scripts examples package.json ../bridge-deploy/releases/v1/
node scripts/switch-release.mjs --root ../bridge-deploy --release v1 --config ../bridge-private/config.json
node ../bridge-deploy/current/src/server.mjs --config ../bridge-private/config.json
```

切换输出应包含 `switched:true`、`database_restored:false`、`server_started:false`。脚本只原子切换 `current` 符号链接；最后一条才启动服务。检查 healthz 后按 Ctrl-C 停止。

演练时可用同一份已审代码建立第二个目录，验证切换机制；真正升级时，`src` 等文件必须来自已测试的新版本，且确认数据库 schema 兼容：

```sh
mkdir ../bridge-deploy/releases/v2
cp -R src scripts examples package.json ../bridge-deploy/releases/v2/
node scripts/switch-release.mjs --root ../bridge-deploy --release v2 --config ../bridge-private/config.json
node ../bridge-deploy/current/src/server.mjs --config ../bridge-private/config.json
```

在第二版服务正常停止后，回滚代码到仍保留的第一版：

```sh
node scripts/switch-release.mjs --root ../bridge-deploy --release v1 --config ../bridge-private/config.json
node ../bridge-deploy/current/src/server.mjs --config ../bridge-private/config.json
```

整个过程使用同一个 release 目录外的数据库和密钥，不还原数据快照。已有 writer lock 会阻止切换；同一进程不能边运行边换代码。这个脚本不处理进程管理器、TLS 代理、远程上传或跨 schema 回滚。

本文命令验收的 `v1` / `v2` 是同一份受审扩展代码、同一 schema 的两个本地发布副本，**不是旧文字版 0.1 与扩展版 0.2**。它们验证代码指针切换、正常启动与数据库不被回退，没有验证任意未来版本的 schema 升级或降级。遇到 schema 不兼容必须保持停机，先制定并审查数据处理方案，不能靠切换符号链接或恢复旧库强行启动。

只有确认锁记录对应的原进程已经不存在，才考虑恢复崩溃遗留锁：

```sh
node scripts/recover-lock.mjs --config ../bridge-private/config.json --confirm-stopped
```

恢复命令仍会检查记录的 PID；无法排除存活进程时拒绝操作。运行成功也不会清除消息或 final 历史。

更多错误类别和逐段验证方法见 [排障说明](TROUBLESHOOTING.md)。

## TLS 入口、停机备份与发布前复核

先由管理员准备独立测试 HTTPS 域名、有效证书和兼容的用户身份服务，再暴露 MCP 入口。代理必须连接配置中的环回地址，保留 Authorization 与规范 Host，不以 `X-User-ID`、Cookie 或自定义转发身份头替代 Bearer 验证。限制公网到本地端口的直接访问；仓库没有自动配置防火墙、证书、OAuth 或进程管理器。

代理的请求体上限须容纳实际 6 MiB MCP 上限，应用仍会重新执行有界检查。代理超时应按独立测试中的最长上传与发送路径制定；代理断开可能发生在 claim 之后，此时不要自动重试或清库。禁止记录 Authorization、请求/响应正文、callback 查询参数或 provider 错误正文。健康检查只访问 `/healthz`，不能把它作为订阅或微信发送成功的监控结论。

做备份前正常停止唯一写入进程，确认它退出及 writer lock 正常释放，再把数据库、加密密钥和私有配置作为一个受保护的集合保存到源码目录外；目录 `0700`、文件 `0600`。绑定与开发 token 也属于私有资料，不上传到源码或公开诊断。不要复制正在写入的数据库当成一致快照。

备份用于灾难恢复规划，不提供随意恢复旧账本后恢复真实发送的许可。旧快照可能遗漏已经发出的 final 或 uncertain；恢复前必须另行设计并审查保留这些历史的流程。日常代码回滚沿用当前账本，保持同 schema。永久撤销和清理数据也不是普通停机命令。

发给朋友前按 [发布检查清单](RELEASE_CHECKLIST.md) 执行 `verify:release`，扫描最终安全解包副本，并核对文件清单。该步骤不会建立公网服务或取得账号资格；真实环境的用户、数据、额外发送和平台适配另行确认。
