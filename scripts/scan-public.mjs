import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP, BlockList} from 'node:net';

// Conservative release gate, not a proof that every possible secret is absent.
// No ignore comments, blanket test exclusion, environment reads, or network.
const textExtensions = new Set(['.mjs', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.example']);
const allowedDotFiles = new Set(['.gitignore', '.env.example', '.node-version']);
const prohibitedDirectories = new Set(['.git', 'node_modules', '.npm', '.ssh', '.wrangler', '.next', 'dist', 'build', 'coverage', 'run', 'runtime', 'logs', 'private-review', '__pycache__']);
const prohibitedExtensions = /\.(?:db|sqlite(?:3)?|sqlite-wal|sqlite-shm|log|pem|key|p12|pfx|crt|cer|jpg|jpeg|png|gif|webp|mp4|pdf|zip|gz|tgz|tar|wasm|node|pyc|map)$/i;
const officialHosts = new Set(['github.com', 'raw.githubusercontent.com', 'developers.openai.com', 'learn.chatgpt.com', 'modelcontextprotocol.io', 'nodejs.org', 'opensource.org', 'www.apache.org', 'www.rfc-editor.org', 'standardwebhooks.com', 'ilinkai.weixin.qq.com', 'novac2c.cdn.weixin.qq.com']);
const placeholder = value => /^REPLACE_WITH_[A-Z][A-Z0-9_]*$/.test(value);
const reservedHost = host => /^(?:[^.]+\.)*(?:example\.(?:com|org|net)|example|invalid|test)$/.test(host) || host === 'localhost';
const documentation4 = new BlockList();
for (const base of ['192.0.2.0', '198.51.100.0', '203.0.113.0']) documentation4.addSubnet(base, 24);
// Exact special-use network bases are policy constants, not deployment IPs.
const policyAddresses = new Set(['0.0.0.0', '10.0.0.0', '100.64.0.0', '127.0.0.0', '127.0.0.1', '169.254.0.0', '172.16.0.0', '192.0.0.0', '192.88.99.0', '192.168.0.0', '198.18.0.0', '224.0.0.0', '240.0.0.0', '::', '::1', '2000::', '2001::', '2001:db8::', '2002::', '3fff::']);
const syntheticFile = relative => /^(?:tests?|examples)\//.test(relative);
// Reviewed transport fixtures substitute both DNS and the socket implementation.
// These exact literals are not endpoints for any actual test network request.
const transportFixtureAddresses = new Set(['93.184.216.34', '2606:4700::1111', '100.64.0.1', '::ffff:127.0.0.1', 'fc00::1']);
const allowedAddress = (value, relative) => policyAddresses.has(value) || isIP(value) === 4 && documentation4.check(value) || relative === 'tests/transport.test.mjs' && transportFixtureAddresses.has(value) || relative === 'scripts/scan-public.mjs' && transportFixtureAddresses.has(value) || syntheticFile(relative) && (value.startsWith('127.') || value.startsWith('10.') || value.startsWith('192.168.') || value.startsWith('169.254.') || value.startsWith('2001:db8:'));
const rules = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['jwt_literal', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ['credential_prefix', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|whsec_[A-Za-z0-9+/]{24,}={0,2})/g],
  ['personal_home_path', /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"'`<>]+/g],
  ['deployment_identifier', /\b(?:appgprj_|asdk_app_|plugin_asdk_|handoff_|wx_)[a-f0-9]{20,}\b/gi],
  ['persistent_uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['opaque_identifier', /\b[a-f0-9]{24,63}\b/gi],
  ['embedded_binary', /data:(?:image|audio|video|application)\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]{24,}/g],
  ['invisible_text', /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g],
];

function reportPath(relative, denylist) {
  if (denylist.some(value => relative.toLowerCase().includes(value.toLowerCase())) || /[\r\n\x00-\x1f]/.test(relative) || /[A-Za-z0-9_-]{40,}/.test(relative)) return '<redacted-path>';
  return relative;
}

function findingsIn(text, relative, denylist) {
  const found = [];
  const add = (rule, index = 0) => found.push({path: reportPath(relative, denylist), rule, line: text.slice(0, index).split('\n').length});
  for (const [rule, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) add(rule, match.index);
  }
  for (const value of denylist) {
    let start = 0, at;
    while ((at = text.toLowerCase().indexOf(value.toLowerCase(), start)) >= 0) {add('private_denylist', at); start = at + value.length;}
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) if (!reservedHost(match[1])) add('personal_email', match.index);
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\)\]}]+/g)) {
    try {
      const url = new URL(match[0]);
      const negativeFixture = syntheticFile(relative) && reservedHost(url.hostname) && placeholder(url.username) && (!url.password || placeholder(url.password));
      if ((url.username || url.password) && !negativeFixture) add('url_credentials', match.index);
      if (!officialHosts.has(url.hostname) && !reservedHost(url.hostname) && !allowedAddress(url.hostname.replace(/^\[|\]$/g, ''), relative)) add('unreviewed_url_host', match.index);
      for (const [key, value] of url.searchParams) if (/(?:token|secret|key|code|credential|signature|encrypted_query_param|upload_param)/i.test(key) && value && !placeholder(value)) add('credential_url_query', match.index);
    } catch {add('invalid_url_literal', match.index);}
  }
  // Standalone host constants/configuration must also use reviewed or reserved hosts.
  for (const match of text.matchAll(/(['"])([a-z0-9-]+(?:\.[a-z0-9-]+)+)\1/gi)) {
    const value = match[2].toLowerCase();
    if (/\.(?:mjs|js|json|md|txt|sqlite|db|test)$/.test(value) || isIP(value) || !/\.(?:com|org|net|io|ai|cloud|app|dev|cn|site|xyz|top|co|me|uk|edu|gov|local|invalid|example)$/.test(value)) continue;
    if (!officialHosts.has(value) && !reservedHost(value)) add('unreviewed_host_literal', match.index);
  }
  for (const match of text.matchAll(/(?<![\w.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![\w.])/g)) if (isIP(match[0]) && !allowedAddress(match[0], relative)) add('nonfixture_ip_address', match.index);
  for (const match of text.matchAll(/(['"])([a-f0-9:]{2,})\1/gi)) if (isIP(match[2]) === 6 && !allowedAddress(match[2], relative)) add('nonfixture_ip_address', match.index);
  // A literal assigned to a credential field must be empty or an exact placeholder.
  // Tests generate keys at runtime; labeling a pasted token "fake" is not an exception.
  const credentialAssignment = /(?:\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|STORAGE_KEY|API_KEY|SESSION_KEY|SIGNING_KEY|CLIENT_SECRET)[A-Z0-9_]*|accessToken|refreshToken|botToken|contextToken|signingSecret|clientSecret|storageKey|qrcode|verifyCode|verify_code|aesKey|aeskey|aes_key|typingTicket|typing_ticket|encrypt_query_param|encrypted_query_param|upload_param|access_token|refresh_token|context_token|signing_secret|client_secret|storage_key|private_key|password|secret|token)\b|["'](?:qrcode|verifyCode|verify_code|aesKey|aeskey|aes_key|typingTicket|typing_ticket|encrypt_query_param|encrypted_query_param|upload_param|access_token|refresh_token|botToken|context_token|signing_secret|client_secret|storage_key|private_key|password|secret|token)["'])\s*[:=]\s*(["'])([^\r\n]*?)\1/g;
  for (const match of text.matchAll(credentialAssignment)) {
    const value = match[2];
    // A prefix used to construct a runtime-generated Standard Webhooks key is not a key.
    const fixtureContext = relative === 'tests/fixture.mjs' && /^['"]?context_token['"]?\s*[:=]/.test(match[0]) && value === 'fixture-context';
    if (value && !placeholder(value) && !fixtureContext && !(value === 'whsec_' && /^\s*\+/.test(text.slice(match.index + match[0].length)))) add('credential_literal', match.index);
  }
  for (const match of text.matchAll(/\bBearer[ \t]+([A-Za-z0-9_./+=-]{8,})/g)) {
    const challenge = match[1] === 'resource_metadata=' && /WWW-Authenticate['"]\s*:\s*['"]$/.test(text.slice(Math.max(0, match.index - 80), match.index));
    if (!placeholder(match[1]) && !challenge) add('bearer_literal', match.index);
  }
  for (const match of text.matchAll(/(['"])([A-Za-z0-9+/=_-]{48,})\1/g)) {
    const value = match[2], prefix = text.slice(Math.max(0, match.index - 80), match.index);
    const digestField = /^[a-f0-9]{64}$/.test(value) && /(?:sha256|tree_hash|manifest_hash)["']?\s*:\s*$/i.test(prefix);
    if (!placeholder(value) && !digestField) add('opaque_literal', match.index);
  }
  if (path.basename(relative) === '.env.example') for (const [lineIndex, line] of text.split('\n').entries()) {
    if (!line || /^\s*#/.test(line)) continue;
    const setting = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!setting) {add('invalid_env_example', text.split('\n').slice(0, lineIndex).join('\n').length); continue;}
    const [ , name, value] = setting;
    if (/(?:TOKEN|SECRET|PASSWORD|KEY|SUBJECT|OWNER|PEER|ACCOUNT)/.test(name) && value && !placeholder(value)) add('nonplaceholder_env_value', text.indexOf(line));
  }
  return found;
}

export function scanTree(root, {denylist = []} = {}) {
  const findings = [], files = [];
  const add = (relative, rule) => findings.push({path: reportPath(relative, denylist), rule, line: null});
  if (!Array.isArray(denylist) || denylist.some(x => typeof x !== 'string' || x.length < 4)) throw new Error('invalid_denylist');
  const absolute = path.resolve(root);
  if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isDirectory()) throw new Error('directory_required');
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name, location = path.join(directory, entry.name), st = fs.lstatSync(location);
      if (st.isSymbolicLink()) {add(rel, 'symlink_forbidden'); continue;}
      if (denylist.some(value => rel.toLowerCase().includes(value.toLowerCase()))) add(rel, 'private_path');
      if (entry.isDirectory()) {
        if (prohibitedDirectories.has(entry.name) || entry.name.startsWith('.')) {add(rel, 'prohibited_directory'); continue;}
        visit(location, rel); continue;
      }
      if (!st.isFile() || st.nlink !== 1) {add(rel, 'nonregular_or_hardlink'); continue;}
      if (prohibitedExtensions.test(entry.name) || entry.name.startsWith('.env') && entry.name !== '.env.example' || /^(?:package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock)/.test(entry.name)) {add(rel, 'sensitive_or_installed_file'); continue;}
      if (entry.name.startsWith('.') && !allowedDotFiles.has(entry.name) || !allowedDotFiles.has(entry.name) && !textExtensions.has(path.extname(entry.name)) && !/^(?:LICENSE|NOTICE|COPYING)$/.test(entry.name)) {add(rel, 'unreviewed_file_type'); continue;}
      if (st.size > 1024 * 1024) {add(rel, 'file_too_large'); continue;}
      const bytes = fs.readFileSync(location); let text;
      try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {add(rel, 'non_utf8_file'); continue;}
      if (bytes.includes(0)) {add(rel, 'binary_file'); continue;}
      if (entry.name === '.node-version' && !/^\d+\.\d+\.\d+\n?$/.test(text)) add(rel, 'invalid_runtime_version_file');
      files.push(rel); findings.push(...findingsIn(text, rel, denylist));
    }
  }
  visit(absolute);
  const unique = [...new Map(findings.map(f => [`${f.path}:${f.rule}:${f.line}`, f])).values()];
  return {schema: 'public-tree-scan-v1', passed: unique.length === 0, scanned_files: files.length, findings: unique};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), root = args[0] ?? '.';
    if (args.length > 1 && (args.length !== 3 || args[1] !== '--denylist-file')) throw new Error('invalid_arguments');
    const denylist = args[1] ? JSON.parse(fs.readFileSync(args[2], 'utf8')) : [];
    const report = scanTree(root, {denylist});
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.passed ? 0 : 1;
  } catch {
    // Never expose an exception, root path, matched text, or denylist content.
    process.stdout.write('{"schema":"public-tree-scan-v1","passed":false,"error":"scan_failed"}\n'); process.exitCode = 2;
  }
}
