# Security model and release checks

This candidate defaults to synthetic messages. Mock completion has `simulated: true` and `sent: false`; it is not a Weixin provider acknowledgement. Real mode requires explicit enablement and a separately provisioned owner binding. Sending additionally requires that binding's send consent. This source preparation does not log in, scan a QR code, publish a service, create credentials or send messages.

## Authority boundaries

- One configured owner, one binding and one store identity are allowed. Never infer identity from caller-supplied proxy headers, email headers, cookies or an unverified first request.
- A public deployment must verify a bearer token against fixed issuer, resource, subject, scope and configured verification keys. A TLS proxy is not an authentication provider. The local mock credential mode is limited to a loopback listener and must not become public authentication.
- Request-token expiration and a granted subscription's lifetime are different concepts. A background subscription may only use the authorization model documented by the runtime; it must still check the local owner/binding policy, subscription expiry and cancellation before accepting a late response. Do not advertise live issuer revocation unless an actual issuer revocation or grant-check integration exists.
- Pause, revocation and close stop delivery. Rebinding must not silently adopt another owner's ledger. A deployment must run one writer for a state directory; do not remove its writer guard to make startup succeed.

## Outbound requests and event integrity

Callback destinations require an explicit hostname allowlist, HTTPS, public destination addresses and TLS certificate validation. The connector pins the checked address for the actual request and does not follow redirects. A DNS result containing a local or private address must fail closed. Apply the same transport restrictions to verification challenges and event deliveries.

A subscription is activated only after a bounded signed challenge succeeds. Event signatures cover the ID, timestamp and exact serialized body. Secret rotation, refresh, restart and unsubscribe must retain the same subscription identity and cancellation rules. Terminal callback rejections suppress that event's retries; transient errors use bounded attempts. A successful callback acknowledges receipt, not completion of the user's task. These protocol requirements are described in the [official MCP Events guide](https://developers.openai.com/plugins/build/mcp-events).

The optional provider transport uses a fixed reviewed API host. Incoming text and quoted content are untrusted data. Accept only the configured peer and bot, supported message shape and bounded time window; do not convert a sent reply into a fresh incoming event. Group messages and arbitrary URL fetching are excluded. Optional outbound images, quote caching, processing, typing, notifications and text acknowledgements require their corresponding local configuration; an incoming message cannot enable them.

## Images and references

Image downloads and uploads use the reviewed Tencent CDN host and restricted routes. Provider-returned URLs are still validated. DNS results must be public, the selected address must be pinned to the actual connection, TLS must verify the hostname, and redirects are not followed. The bot's bearer token is used only for the fixed API endpoint and is never sent to the CDN. Download parameters, upload parameters, encryption keys and typing tickets must not enter logs or ordinary tool metadata.

PNG/JPEG handling limits plaintext to 4 MiB, each dimension to 8,192 and total pixels to 8,388,608. Encrypted bytes have only the bounded block-padding allowance. Declared media type must agree with parsed bytes for outbound images; a response header cannot override the parsed image type. PNG image-data decompression has a computed output bound. Outbound JPEG additionally requires supported 8-bit Huffman baseline/progressive structure, tables, component references, scan ordering and an exact end marker; a header with plausible dimensions is insufficient. These are format and resource checks, not a complete image/entropy decoder, metadata scrubber or guarantee against every downstream renderer flaw. Avoid treating supplied media as safe executable content. The protocol's AES-128-ECB and MD5 fields provide compatibility; they do not supply authenticated media encryption or a modern integrity proof.

An image tool accepts bounded bytes, not a local file path or remote source URL. An outbound final is either text or one image; caption arguments are rejected. Text and image finals share the same durable claim. The claim must exist before obtaining upload credentials or uploading bytes. If upload or message delivery becomes uncertain, leave the claim occupied and do not automatically upload or send again. The provider may retain uploaded media even if the final message step fails. Image downloads recheck the original message, binding and expiry after the asynchronous operation; decrypted pixels are not stored in a durable cache.

Inline references retain only a limited text/title/type/ID projection and always remain untrusted. They do not authorize access to a referenced account, URL, nested message or media key. The optional text cache is scoped to the configured owner, bot, peer and original binding time. It permits at most 512 entries, makes them eligible for one hour from their original timestamps, uses encrypted records, and suppresses conflicting reuse of a reference ID. Looking up a reference does not extend its lifetime. Cleanup requires a running process or a later startup/access; stopped files and backups can retain encrypted bytes. No exact physical erasure is promised. This is not access to general Weixin history or other conversations.

Combined reads select at most three messages. Each item is verified independently and the whole batch is rechecked after all asynchronous image reads. Native-image indexes identify the exact content block for each item; they do not prove which event woke the host. The aggregate result budget is below 6 MiB with room for the RPC envelope. Reading does not claim a final reply, send an acknowledgement or start typing.

## Work indicators, acknowledgements and notifications

Processing is an explicit local work declaration. A running lease lasts at most 45 seconds, is capped at ten minutes from its first start, and remains subject to the original message's one-hour window. It does not prove that a model is executing. Optional typing uses memory-only tickets, does not replay a running lease after restart, and cannot turn a late response into a renewed authorization. A successful typing request does not prove that Weixin displays the indicator. Cancellation or an abrupt process stop can leave provider-side visibility unknown.

The separately enabled receipt-typing option can request one short, locally bounded five-second indication after a valid incoming message. Its durable claim suppresses replay. It is a receipt hint, not a declaration that the host has started processing. Ordinary reads do not activate it.

The separately enabled provider-start notice is a receive-lifecycle API request, not a chat message. It is off by default, runs at most once per runtime generation before polling, and does not retry a failed attempt within that generation. It does not prove that a host has started work or that a message reached the user.

Text acknowledgements are a separately enabled, explicit send with their own persistent claim. Receiving or reading a message does not automatically send one. They do not consume the final-reply claim, and an uncertain acknowledgement must not be retried under a fresh identity. An in-flight acknowledgement must settle before the final response is dispatched.

Notifications require separate local opt-in and the existing fixed owner destination. The caller cannot supply another recipient or a conversation credential. Each occurrence uses its own stable ID and persistent claim, has at most five minutes of local validity, and requires a recent context from a verified inbound message. The context-age policy defaults to one hour and can be explicitly configured up to three hours; neither duration establishes provider validity. Local rate and ledger-capacity limits apply. A prior unresolved notification blocks another send; failures must not be bypassed by choosing a different occurrence ID. Notification completion and an inbound final reply remain separate records.

The optional local enrollment flow is absent from MCP. It requires explicit enablement, local consent and confirmation of the returned owner/bot before a binding may be saved. It does not run during mock startup, events or tests. Session expiry, cancellation, fixed provider destinations and private-file permissions still apply. Never copy a populated binding, QR value or verification code into this project, a public issue or a diagnostic transcript.

## Persistence and uncertain outcomes

Use a private state directory and an independently provisioned encryption key outside the source tree. Do not commit a populated binding file, state database, plaintext message, encryption key or provider credential. Sensitive record bodies are encrypted; SQLite itself is not wholly encrypted, and operational timestamps, hashes and claim states remain metadata. Store identity checks prevent accidental reuse across owners or modes. Retained deduplication/claim entries are intentional; do not erase them merely to retry an operation.

This extended candidate uses state schema 2. The earlier text-only schema 1 and this schema cannot open one another's populated stores. Startup checks the identity before updating state, and the release-switch helper rejects a mismatched schema before changing the current-release link. These checks are not a migration or a downgrade mechanism. Roll back only to an approved release with the same state schema; never substitute an older database to make the code start.

A final reply is claimed before a real send. If a process crashes or the provider's outcome is unclear, preserve an uncertain claim and avoid automatic resend under another ID. Local mock finalization must remain atomic. Callback receipt followed by a crash can still lead to a retry using the same event ID: this is not an exactly-once remote guarantee.

Do not log request or response bodies, Authorization headers, signing keys, callback URL query strings, raw errors or account files. Operational diagnostics should use reviewed categories and bounded counters. Collect minimal metadata when investigating a failure.

## Scan a release candidate

From the candidate root, run:

```sh
node scripts/scan-public.mjs .
```

Scan the final archive after safe extraction into a separate empty directory as well. The scanner accepts directories, never extracts archives or follows symlinks. Keep reports and archives outside the scanned source tree. Its exit codes are `0` for no findings, `1` for findings and `2` for a failed scan. Findings contain only a relative path, rule and line number; matched values and raw exceptions are not printed.

The scanner rejects repository history, installed dependencies, state/log/key files, binary media, symlinks, hard links, personal paths, nonexample identities, unreviewed URL hosts and credential-shaped literals. Media keys, access parameters, typing tickets, QR values and verification-code fields are included. Examples must use an exact `REPLACE_WITH_...` placeholder. Prefixing a pasted secret with an example label does not exempt it. Tests generate keys and image pixels at runtime; test directories have no blanket exemption. Narrow exceptions cover reviewed upstream hosts, reserved example domains, specific network-policy bases, documentation addresses, and exactly one `fixture-context` marker in `tests/fixture.mjs` that has no external authority. URL-credential rejection fixtures require complete placeholders, a reserved host and a test/example path. An explicit SHA-256 field can contain a digest, not an arbitrary opaque credential field.

Reviewers can pass an additional private denylist through the exported `scanTree` function in memory or through `--denylist-file` outside the public tree. Never ship that private list. Scanning is heuristic: manual provenance, configuration, import and archive review remain required. A clean scan is not a guarantee that all sensitive information has been detected.

The transport test's small enumerated address set is separately reviewed: its DNS resolver and socket request are both replaced by in-process functions. Those positive/negative address literals are permitted only in that test file and in the scanner's own rule declaration. They are not a general allowance for public deployment IPs or other test files.

## Reporting a vulnerability

The release-preparation follow-up also rejects FIFO and other special-file inputs without waiting for a writer before the regular-file check. HTTP MCP requests require the exact case-insensitive `application/json` media type (parameters are permitted), rather than accepting a prefix such as `application/jsonp`. These changes do not alter authentication, feature consent or outbound destinations. Reproductions are included in `tests/release-security.test.mjs`; scanner positive/negative checks are included in `tests/scanner.test.mjs`.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/dannywu19910524/buu-weDot/security/advisories/new). Do not put credentials, account exports, private message text or a working exploit against an individual's deployment in a public issue. Provide the affected version, security boundary and a minimal synthetic reproduction. This project does not publish a personal email address as its security channel. If the private report form is unavailable, do not post the sensitive report in a public issue.
