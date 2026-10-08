export class BridgeError extends Error {
    reason;
    code;
    details;
    constructor(reason, code = -32602, details) { super(reason); this.reason = reason; this.code = code; this.details = details; }
}
export const EVENT = "weixin.message.created", BINDING = "mock-binding", MAX_BODY = 262144;
export const encoder = new TextEncoder();
export const encode = (v) => JSON.stringify(v);
export const b64 = (v) => btoa(String.fromCharCode(...v));
export function unb64(v) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4)
        throw new BridgeError("invalid_key");
    try {
        return Uint8Array.from(atob(v), x => x.charCodeAt(0));
    }
    catch {
        throw new BridgeError("invalid_key");
    }
}
export function signingKey(v) {
    if (typeof v !== "string" || !v.startsWith("whsec_"))
        throw new BridgeError("invalid_signing_secret");
    const key = unb64(v.slice(6));
    if (key.length < 24 || key.length > 64)
        throw new BridgeError("invalid_signing_secret");
    return key;
}
export function equal(a, b) {
    const aa = encoder.encode(a), bb = encoder.encode(b);
    let diff = aa.length ^ bb.length;
    for (let i = 0; i < Math.max(aa.length, bb.length); i++)
        diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
    return diff === 0;
}
export async function sha(v) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(v))))
        .map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function sign(secret, id, stamp, body) {
    const key = await crypto.subtle.importKey("raw", signingKey(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return "v1," + b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${stamp}.${body}`))));
}
export async function seal(value, storageKey, aad) {
    const raw = unb64(storageKey);
    if (raw.length !== 32)
        throw new BridgeError("storage_key_unavailable", -32603);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, encoder.encode(encode(value)));
    return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}
export async function unseal(value, storageKey, aad) {
    const [version, iv, cipher] = value.split(".");
    if (version !== "v1")
        throw new BridgeError("storage_invalid", -32603);
    const key = await crypto.subtle.importKey("raw", unb64(storageKey), "AES-GCM", false, ["decrypt"]);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: encoder.encode(aad) }, key, unb64(cipher))));
}
export function object(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new BridgeError("invalid_arguments");
    const v = value;
    if (required.some(k => !(k in v)) || Object.keys(v).some(k => ![...required, ...optional].includes(k)))
        throw new BridgeError("invalid_arguments");
    return v;
}
export function text(value) {
    if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > 4096)
        throw new BridgeError("invalid_text");
    return value;
}
export function callbackURL(value, hosts) {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value))
        throw new BridgeError("unsafe_callback", -32015);
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new BridgeError("unsafe_callback", -32015);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443") || !/^[a-z][a-z0-9.-]*[a-z]$/.test(url.hostname))
        throw new BridgeError("callback_host_not_allowed", -32015);
    // The authenticated subscription caller may need the exact hostname to
    // configure its approved egress. Never return the URL path/query or key,
    // never log this hint, and never add it to the allowlist automatically.
    if (!hosts.includes(url.hostname))
        throw new BridgeError("callback_host_not_allowed", -32015, { callbackHost: url.hostname });
    return url.href;
}
export async function readBounded(response, max = MAX_BODY) {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.length;
            if (size > max) {
                await reader.cancel();
                throw new BridgeError("payload_too_large");
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
}
