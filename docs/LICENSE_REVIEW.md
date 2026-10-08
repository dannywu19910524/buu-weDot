# License and provenance review

Initial review date: 2026-10-06; owner decisions confirmed on 2026-10-08. This is a technical inventory and an owner-confirmed distribution decision, not an independent determination of every contribution's ownership or of service terms.

## Scope

This extended candidate extracts and rewrites reusable bridge functionality from a private predecessor. Its scope includes request authentication, signed events, persistence and the optional capabilities listed in the feature matrix. Media upload is a new implementation rather than a feature already present in the reviewed private predecessor. The private application's deployment environment, account data, populated databases, historical receipts and git history are excluded. See [the public/private feature comparison](PUBLIC_PRIVATE_DIFF.md) for implemented capabilities and remaining platform adapters.

The implementation author must identify direct copying as well as adaptations in the retained private provenance map. The independent review checks selected source files and that map; it cannot establish the ownership of every earlier private contribution. A private predecessor without an explicit license does not acquire an open-source license merely by being copied into this directory. The project owner has confirmed authority for those contributions for this source publication. Protocol field names, algorithms and observed upstream behavior must not be used to obscure copied implementation text.

## Primary-source checks

- Tencent's [repository README](https://github.com/Tencent/openclaw-weixin/blob/main/README.md) and [LICENSE](https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE) identify MIT licensing. Its notice must accompany copies or substantial portions. That does not settle ownership of this project's other code or grant service access.
- Tencent's [protocol reference](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md) and linked client implementations were checked for media and typing behavior. This candidate applies its own restrictive destination, resource and retry policies; implementing compatible requests is not a claim of complete server compatibility or an upstream security endorsement.
- [OpenAI's MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) describes authenticated discovery, subscription and signed callback delivery. It is a protocol reference here; no SDK or guide text is bundled.
- [Node's license inventory](https://github.com/nodejs/node/blob/v24.x/LICENSE) includes third-party component notices. Node is an external prerequisite, not part of this source archive.
- The [MIT text](https://opensource.org/license/mit) and [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) were used to compare the two proposed choices.

Upstream branch URLs can change. The private audit records the retrieved source hashes and retrieval time. Recheck the exact upstream revision when adding copied code or preparing a later release.

## Dependency decision

The intended public package has no npm dependencies or devDependencies. Built-in Node modules are runtime dependencies, not third-party source vendored into this archive. Media fixtures must be generated from synthetic buffers by the tests; they must not include photographs, downloaded media, bundled fonts or image-codec packages. The audit must confirm that package metadata, import inventory and archive contents match these claims. No inference about the redistribution rights of a full Sites template is needed because that template is excluded.

## Selected license

Update 2026-10-08: the owner confirmed public source publication under MIT, copyright attribution to buu, and the right to distribute the retained code including historical contributions. MIT is recorded in package metadata and the standard text is included in `LICENSE`. The comparison below remains the basis for the selection.

| Choice | Practical consequence |
| --- | --- |
| MIT — suggested after rights confirmation | Short permissive terms and retention of the license notice. It has no express patent-grant section. |
| Apache-2.0 — alternative | Adds express contributor patent licensing and termination conditions, change notices and applicable NOTICE obligations. It requires a more detailed compliance review when combined with other code. |

The source-rights decision is an owner declaration; the technical audit does not independently establish every historical contribution's ownership. If any Tencent implementation is later copied, assess its MIT notice separately instead of replacing it with this project's license.

## Confirmed decisions and future provenance obligations

- MIT, buu attribution and retained-contribution distribution rights were confirmed by the owner for this source publication.
- Any later bundled runtime, template, SDK, dependency or asset needs a fresh inventory and notice review.

Passing functional tests and sensitive-content scanning does not resolve these items. The candidate also does not determine whether a particular account is eligible to use Weixin or ChatGPT event integrations; the operator must follow those services' current access requirements.
