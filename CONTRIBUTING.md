# Contributing

Use the documented Node 24 runtime and POSIX environment. Keep local settings, account files, state, logs and verification reports outside the source tree. Reproduce bugs with synthetic messages and generated media; do not include credentials or personal message content in a report or patch.

Before proposing a change, run `npm run --silent verify:release > ../candidate-verification.json` and inspect the exit status and parsed report. Changes to authority, destinations, claims, retries or media handling need an explicit review of those boundaries. Mock tests do not establish real cloud or Weixin compatibility.

Explain the user-visible behavior and relevant validation in the change description. Include only code or assets you are authorized to contribute, retain required third-party notices, and identify copied or adapted implementation. Contributions are intended for this project's MIT license. See LICENSE for the permission and copyright notice.

Use [GitHub private vulnerability reporting](https://github.com/dannywu19910524/buu-weDot/security/advisories/new) for vulnerabilities. Do not post private data or a working exploit against a user's deployment publicly. See [the security model](docs/SECURITY.md).
