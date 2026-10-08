# 扩展工程的能力与边界

图片、引用、typing 和通知是可以通用化的业务能力；账号、身份、callback、历史消息及授权证据则是部署者的私有状态。本页逐项标记代码存在、默认值、依赖和验证范围，不将默认关闭写成没有实现，也不将平台适配缺失写成个人数据无法公开。

2026-10-08 候选的可重复验证定义为 **126 项本地自动化测试（保留 90 项项目测试＋8 项新增安全反例＋28 项新增扫描器自测）及两个进程内 mock demo**。原 2026-10-06 文档记录的 20 步本地运维命令验收属于历史记录，本轮没有将其重新计数为当前验收；本轮运维行为由随包自动化测试覆盖。测试只使用合成消息、临时状态与受控网络替身；代码切换中的 `v1` / `v2` 是同 schema 扩展副本。当前没有真实云端订阅、真实二维码或微信收发验收，本地成功不能替代 provider 和目标 dot 的端到端验收。

| 能力 | 当前实现与默认行为 | 具体边界 | 本地验证入口 |
| --- | --- | --- | --- |
| 文本入站与 final | 已实现，默认 mock；真实发送另需同意 | 唯一 owner、固定原收件人、原始一小时、持久 final claim、uncertain 不重试 | [核心测试](../tests/core.test.mjs) |
| PNG/JPEG 入站 | 已实现，`inboundImages:true` | 固定 CDN、DNS 钉住、解密、体积/像素/格式检查、下载后复核原记录 | [媒体测试](../tests/extended-media.test.mjs) |
| PNG/JPEG 出站 | **新增**，`outboundImages:false` | image-only final，拒绝 caption；接受受限 base64 字节，不接受 URL/路径；上传前 claim，与文本 final 二选一 | 媒体测试、[状态测试](../tests/extended-state.test.mjs) |
| dot 素材导出 | **未内置宿主适配器** | 附件 / Library / 图片生成结果须由宿主已有授权能力导出字节；视觉可见不等于 bytes 可用 | 需目标宿主另验，mock 不能证明 |
| inline 引用 | 已实现；作为不可信数据投影 | 不保留作者身份授权、任意媒体 URL、key 或嵌套指令 | 状态测试 |
| 本人文本引用缓存 | 已实现，`quoteCache:false` | 显式开启，同 owner/bot/peer/绑定下界；原始一小时、最多 512 条、冲突不解析 | 状态测试 |
| 引用式文本 final | 已实现，`quoteReplies:true` | 引用原已核验消息；文字引用图片不等于图片发送，UI 未验 | 状态与媒体测试 |
| processing | 已实现，`processing:false` | real 需发送同意；lease 45 秒、单次最多十分钟且受原始一小时约束；调用方声明不证明模型在运行 | 状态测试 |
| 工作 typing | 已实现，`typing:false` | 需 processing 与真实发送同意；固定本人、有限请求、内存 ticket；不证明 UI 可见 | 状态测试 |
| 入站短提示 | 已实现，`receiptTyping:false` | 需 typing 与 processing，real 需发送同意；最多一次五秒提示、持久防重播；不表示已开始工作 | 状态测试 |
| 主动通知与查询 | 已实现，`notifications:false` | 独立通知 claim、固定本人、新鲜事件、限频、未解决结果阻断；context 默认一小时、最大三小时为本地策略 | 状态测试 |
| 提供方启动通知 | 已实现，`providerStartNotice:false` | real 轮询前每运行代次最多尝试一次，不自动重试；不是发给用户的聊天消息，无 MCP 工具 | 状态测试 |
| 有界合并读取 | 已实现，`read_pending_weixin` 最多三条 | 最后一次异步读取后重核全部条目，图片索引逐条对应；不 claim、不 send，不保证全局公平 | 媒体测试 |
| 临时文字确认 | 已实现，`acknowledgements:false` | 显式额外发送，独立持久 claim；不会自动回复入站，不消耗 final，不确定不重试 | 状态测试 |
| 本地二维码绑定 | 状态机与 TTY 管理已实现，只有显式 CLI 才启动 | 五分钟、固定 API、隐藏验证码、本人核对、0600 文件；QR 显示需可信本地工具，不开放 MCP 登录工具 | [enrollment stub 测试](../tests/enrollment.test.mjs)；真实扫码未验 |
| MCP Events | 已实现发现、订阅、challenge、签名、有界重投 | HTTPS 白名单、有限订阅、一个绑定一个 callback；2xx 不代表 dot 已醒 | [事件与身份测试](../tests/events-auth.test.mjs)、`demo:mock` |
| JWT 资源身份验证 | 已实现；local bearer 仅本机 mock | 不内置 OAuth 授权服务器；不信任任意用户 header；issuer 即时吊销另需集成 | 事件与身份测试 |
| Sites 网页及身份适配 | **未提供** | 需要平台认证、状态库、同源/CSRF 和服务控制；通用 Node 入口不能替代 | 需独立适配与验收 |
| 同一入口 mock / real | **未提供统一路由** | 本树一个进程一种 mode，各自数据库、密钥和订阅；不得共库切 mode | 核心的 mode/身份隔离测试；双模式路由未实现 |
| 单机代码切换 | 已实现 `switch-release` 与 writer lock | 本次验证同 schema 扩展副本；当前脚本拒绝跨 schema 切换，旧文字 0.1 与扩展 schema 2 运行时互拒，不回退数据库 | [运维测试](../tests/operations.test.mjs)、文档命令演练 |
| 跨平台在线迁移 | **未提供** | 原平台冻结、写入栅栏、摘要、激活回执和旧调用防写不是单机回滚脚本的等价物 | 需独立平台实现；未来 schema 回滚未验证 |

图片出站在已核查的原成熟桥接里没有对应上传与发送路径，必须按新功能验收；图片入站、引用、缓存、工作状态和通知则有原业务设计可复用。详细差异见 [公开版与原工程](PUBLIC_PRIVATE_DIFF.md)。

## 工具和参数如何选

精确输入 schema 以当前连接的 `tools/list` 为准，宿主可能为工具名添加前缀。下面列出本树的业务名称；MCP 事件订阅使用 `events/subscribe`，不是业务工具。可选工具即使出现在目录中，实际调用仍受开关与授权约束。

| 工具 | 用途与主要参数 |
| --- | --- |
| `bridge_status` | 无参数；读取无凭据的状态与待办定位信息。 |
| `get_message` | `binding_id`、权威 `message_id`；独立核验并读取一条。 |
| `read_pending_weixin` | `binding_id`、可选 `limit`（1–3）；读取有界批次，不推断它就是某个缺失事件。 |
| `list_pending_weixin` | `binding_id`、可选 `limit`（1–50）和 `cursor`；定位分页待办。 |
| `reply_weixin` | `binding_id`、`message_id`、`text`；一次文字 final。 |
| `reply_weixin_image` | `binding_id`、`message_id`、`image:{mime_type,data}`；一次无 caption 图片 final。 |
| `processing_weixin` | `binding_id`、`message_id`、`phase`；`running` / `waiting` / `completed` / `failed`。 |
| `acknowledge_weixin` | `binding_id`、`message_id`、`text`；默认关闭的额外临时确认。 |
| `notify_owner` | `binding_id`、稳定 `notification_id`、`text`、`created_ms`、`expires_ms`；独立的新通知。 |
| `notification_status` | `binding_id`、可选 `notification_id`；只查询本地通知策略与状态。 |
| `mock_weixin_inbound` | 仅 mock：`binding_id`、seed 形式的 `message_id`、`nonce`，可选 `kind` 和合成 `quote`；使用返回的权威 ID。 |
| `pump_mock_events` | 仅 mock，无参数；在原有预算内处理到期合成回调。 |

当前绑定名分别为 `mock-binding` 和 `real-binding`，不是部署者随意创建的收件人标识。业务消息 ID 与通知 ID 形态不同，不能用随机换 ID 绕过去重。图片字节通路见 [中文攻略](GUIDE.zh-CN.md)，确切功能默认值见 [部署配置](DEPLOYMENT.md)。

## 真实宿主和提供方仍需验证

同一个 dot 的原生唤醒需要宿主支持该账户的私有插件与 MCP Events。通用桥能实现协议，不能替宿主提供事件任务资格、OAuth 客户端注册、素材读取权限或调度能力。[OpenAI 官方前提](https://developers.openai.com/plugins/build/mcp-events#before-you-start)

图片 upload/send、引用 UI、typing UI、主动通知 context 与二维码均未在本次准备中真实验收。通知本地 TTL 不是 provider 的有效期承诺；单次本地 final claim 也不是跨系统原子送达保证。

群聊、多账户、语音、视频、文件，以及跨会话任意历史查询，都没有在已核的原成熟桥接中找到对应完整实现。它们可以作为后续新功能，不能仅凭 Tencent 上游插件的目录声称本工程已支持。[Tencent 官方仓库](https://github.com/Tencent/openclaw-weixin)
