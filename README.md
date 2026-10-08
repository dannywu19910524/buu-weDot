# buu-weDot

微信连接 dot。

项目与 GitHub 仓库名为 **`buu-weDot`**；npm 包标识为小写 `buu-wedot`。两者对应同一工程。

面向已有 dot 的单用户微信桥接工程候选。桥接服务通过 MCP Events 通知宿主，由原 dot 调用读取与回复工具；不包含独立模型助手或模型 API 调用。

扩展范围包括图片、引用与本人文本缓存、processing / typing、主动通知、合并读取和显式本地绑定流程。图片出站是新增能力；图片入站等通用业务来自既有桥接设计，不属于需要隐藏的个人数据。各项实现状态、默认开关与验证边界见 [能力矩阵](docs/CAPABILITIES.md)。

**本项目采用 MIT，版权署名为 buu。真实云端 MCP Events、目标 dot 和微信端到端验收尚未完成。** 请先阅读 [许可状态](LICENSE_STATUS.md)、[发布说明](docs/RELEASE_NOTES.md) 与 [安全说明](docs/SECURITY.md)。源码公开不代表已经部署或连接任何账号。

## 从哪里开始

- [中文架构攻略](docs/GUIDE.zh-CN.md)：为什么使用 Events、如何保持同一个 dot，以及三层验收路线。
- [部署与回滚](docs/DEPLOYMENT.md)：本地 mock、身份前提、功能开关、宿主验证和本人绑定。
- [排障](docs/TROUBLESHOOTING.md)：逐段区分发现、订阅、唤醒、读取和 final。
- [公开候选与私有系统差异](docs/PUBLIC_PRIVATE_DIFF.md)：功能边界和未移植项。
- [完整能力矩阵](docs/CAPABILITIES.md)：通用功能、额外授权与平台适配边界。
- [发布检查清单](docs/RELEASE_CHECKLIST.md)：可重复验证、许可决定与真实验收前置条件。
- [第三方说明](THIRD_PARTY_NOTICES.md)、[许可审查](docs/LICENSE_REVIEW.md)。

## 运行边界

运行环境是 Node.js `>=24.21.0 <25` 与 POSIX 系统（macOS、Linux 或 WSL；原生 Windows 不支持），核心不需要运行时 npm 依赖。在仓库根目录先运行本地合成验收：

```sh
node --version
npm test
npm run demo:mock
npm run demo:features
```

打包前可执行 `npm run --silent verify:release > ../candidate-verification.json`，将报告留在源码目录外。该入口复用全部测试、两项 demo 和扫描，记录验证前后相同的源码清单与摘要，并拒绝不支持的运行时。报告通过仍仅代表本地技术检查。

需要本机 HTTP 服务时，再初始化一个新的私有目录：

```sh
npm run init:local -- --directory ../bridge-private
npm start -- --config ../bridge-private/config.json
```

初始化只生成 mock 开发 token 和状态密钥，不取得微信凭据。目录已存在时会拒绝覆盖。默认 mock，真实微信访问和本地绑定流程都需要显式操作，启动或入站事件不会自动扫码。单用户授权、签名 callback、地址校验、持久去重和 final 占用是服务端责任。

`demo:mock` 验证文本闭环；`demo:features` 再演示合成图片原生读取、两条独立消息的合并读取、不可信引用、工作 lease、模拟图片 final、临时确认和通知。两者均为进程内 mock，provider 与外部网络调用为零，不登录或扫码。

接到同一个 dot 还需要宿主支持私有 MCP 插件、自定义事件订阅、受支持的用户身份接入和原生事件任务。官方 MCP Events 文档列出 Work 与 dots 的支持范围和工作区限制；普通工具可调用并不代表事件功能已经可用。[官方能力说明](https://developers.openai.com/plugins/build/mcp-events)

本项目不依赖 Sites。若选择 Sites，仍须使用该平台实际提供的 MCP、身份及部署机制；此仓库没有打包 Sites 适配器，也不能把本地 Node 服务直接当作已部署的 Site。

## 验证原则

先通过零外网的本地 mock，再通过目标 dot 的 mock 订阅，最后才开启本人真实文本接收与发送。图片等扩展功能另做逐项验收。webhook `2xx`、mock final 和提供方发送确认分别代表不同阶段。

图片出站工具接收 PNG/JPEG 的 base64 字节，不接收 Library ID、图片生成结果 ID、URL 或服务器路径。宿主需要有获授权的方式取得图片原始字节并交给该工具；本仓库没有内置宿主素材导出适配器。模型能看到图片不等于这条字节通路已经可用。

本地测试不代表云端订阅成功。本候选没有公网端到端性能基准，不承诺十秒响应。群聊、多账户、语音、视频、文件和任意会话历史不属于已核验的原桥接能力，也不能因为 Tencent 上游支持就声称本工程已实现。

协议参考：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)、[Tencent 接口文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)。
