# 原 29 项独立反例的追溯与当前覆盖

本页对应 2026-10-08 的有界补核。原 2026-10-06 回执记录“独立编写的运行时与安全反例 29/29”，但没有逐条名称、输入、断言、执行脚本或完整输出；原冻结 ZIP 的 56 文件也没有这组独立脚本。原回执、原包测试与相关记忆摘要的定向核查没有恢复该清单。因此不能执行或证明原 29 项逐项复跑，也不能把新 8 项 `release-security` 当作它们的等价替代。

原回执明确列出的发现仍适用于当前实现。下表将其分为九个已知类别，映射到可执行的项目回归；九个类别不是原 29 项的逐项清单或数量分配。

| 原回执已知类别 | 当前可执行测试 | 证据与边界 |
| --- | --- | --- |
| ACK 在途记录被重复请求覆盖 | `extended-state`：a pending acknowledgement is not displaced by duplicate requests and final waits for it | 拒绝在途重复 ACK，等待原 ACK 后才开始 final |
| 无 ACK 时 final 让出执行导致竞争 | `extended-state`：final synchronously claims before a same-turn ack; NUL ack is rejected before send | 同一轮 final 先占用槽位，再来的 ACK 被拒绝，只有一次 final provider 调用 |
| ACK 接受空字符 | 上一项测试中的 NUL ACK 反例 | NUL 输入在发送前被拒绝；不将字符串中的其他未知输入变体视为已覆盖 |
| 图片响应类型遗漏 | `extended-media`：mock image event…；image final uses one claimed upload/send pipeline… | mock 与 real 替代传输分支均断言 `response_kind:image`；本补核加强后者断言，没有真实发送 |
| 二维码目录权限 | `enrollment`：local CLI saves only private binding…；CLI rejects noninteractive/default launch… | 新目录 `0700`、绑定文件 `0600`，拒绝可写父目录；本补核加强目录权限断言，只使用 stub provider 与假的 TTY 输入 |
| 二维码参数解析 | `enrollment`：CLI rejects noninteractive/default launch, malformed arguments and writable parent before start | 缺少目录值、目录值为选项、重复目录选项、额外位置参数均拒绝；拒绝前 provider 调用为零 |
| 伪 JPEG 结构 | `extended-media`：outbound JPEG requires complete tables and legal scans… | 伪短 JPEG、缺量化/Huffman 表、空扫描、尾随内容被拒绝；不能占用 final |
| 非法渐进扫描顺序 | 上一项 JPEG 测试 | 重复初始 DC、无初始扫描的 refinement 被拒绝；不是完整熵解码或所有 JPEG 变体保证 |
| 文字/图片错误幂等判定 | `extended-state`：image digest preimage as a text final cannot masquerade as an image duplicate in either order | 两种顺序均拒绝把另一种 final 伪装成重复成功，保留共享 claim |

定向执行如下 8 个已存在的测试，用 Node 24.21.0 得到 8/8、无失败、跳过或取消。它们属于原随包 90 项中的回归，不新增到本轮 126 总数；两处加强断言也不改变顶层测试用例数。

```sh
node --test --test-reporter=tap --test-name-pattern='^(a pending acknowledgement|final synchronously claims|mock image event|image final uses|local CLI saves|CLI rejects noninteractive|outbound JPEG requires|image digest preimage)' tests/extended-state.test.mjs tests/extended-media.test.mjs tests/enrollment.test.mjs
```

## 仍然存在的历史证据缺口

- 缺少原 29 项的具体名单、输入/调度、预期结果和脚本，不能确定各已知类别在原 29 项中的数量，或其中是否包含其他未在摘要列出的边界。
- 当前命名回归与可见断言证明上表中的具体行为；不能证明等价覆盖原审查者的所有并发时序、权限变更或格式边界。需要原审查者提供脚本或逐项记录后才能做一对一确认。
- 原审查者的 28 项扫描器自测同样没有随包；当前新增 28 项自测可重复执行，但不声称新旧逐项一致。

准确总数仍为：历史 `147=90+29+28`；当前 `126=90+8+28`。本次定向重复运行、独立副本运行与最终 ZIP 复验均不累计。没有移除原随包 90 项；未将原 29 项认定为不适用、通过、自动被替代或已经复跑。
