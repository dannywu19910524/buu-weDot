import { encoder } from './security.mjs';
const unavailable = () => ({ inbound_quote_status: 'unavailable' });
const statuses = ['none', 'invalid', 'not_captured', 'unavailable'];
const cacheID = (v) => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= BigInt('18446744073709551615');
export function inboundQuoteProjection(receipt, nowMs = Date.now()) {
    const status = receipt.inbound_quote_status;
    if (typeof status === 'string' && statuses.includes(status))
        return { inbound_quote_status: status };
    if (status !== 'captured')
        return unavailable();
    const q = receipt.inbound_quote;
    if (!q || typeof q !== 'object' || Array.isArray(q))
        return unavailable();
    const v = q;
    const bounded = (s, max) => s === null || (typeof s === 'string' && s.length > 0 && encoder.encode(s).length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s));
    if (v.trust !== 'untrusted' || v.source !== 'current_message_ref_msg' || typeof v.message_type !== 'string' || !['text', 'image', 'voice', 'file', 'video', 'unknown'].includes(v.message_type) || typeof v.content_status !== 'string' || !['inline_text', 'cached_text', 'media_metadata_only', 'reference_only', 'metadata_only'].includes(v.content_status) || !bounded(v.text, 4096) || !bounded(v.title, 512) || (v.reference_id !== null && (typeof v.reference_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(v.reference_id) || v.reference_id === '0')) || typeof v.truncated !== 'boolean' || v.pixels_available !== false || typeof v.history_lookup_performed !== 'boolean')
        return unavailable();
    if ((v.text !== null && v.message_type !== 'text') || (['inline_text', 'cached_text'].includes(v.content_status) && v.text === null) || (v.content_status === 'reference_only' && (v.reference_id === null || v.text !== null || v.title !== null)))
        return unavailable();
    let resolution;
    if (v.history_lookup_performed) {
        const raw = v.resolution;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !cacheID(v.reference_id))
            return unavailable();
        const r = raw;
        if (r.source !== 'same_conversation_text_cache' || r.policy !== 'owner-text-1h-v1' || !['resolved', 'not_found'].includes(String(r.status)))
            return unavailable();
        resolution = { status: r.status, source: r.source, policy: r.policy };
        if (r.status === 'resolved') {
            if (v.content_status !== 'cached_text' || v.message_type !== 'text' || v.text === null || !Number.isSafeInteger(r.source_created_at_ms) || Number(r.source_created_at_ms) < 0 || Number(r.source_created_at_ms) > nowMs || r.expires_at_ms !== Number(r.source_created_at_ms) + 3600000 || Number(r.expires_at_ms) <= nowMs || !['inbound', 'outbound'].includes(String(r.original_direction)))
                return unavailable();
            resolution = { ...resolution, source_created_at_ms: r.source_created_at_ms, expires_at_ms: r.expires_at_ms, original_direction: r.original_direction };
        }
        else if (!['unknown', 'text'].includes(v.message_type) || v.text !== null || !['reference_only', 'metadata_only'].includes(v.content_status))
            return unavailable();
    }
    else if (v.content_status === 'cached_text' || v.resolution !== undefined)
        return unavailable();
    return { inbound_quote_status: 'captured', inbound_quote: { trust: 'untrusted', source: 'current_message_ref_msg', reference_id: v.reference_id, message_type: v.message_type, text: v.text, title: v.title, content_status: v.content_status, truncated: v.truncated, pixels_available: false, history_lookup_performed: v.history_lookup_performed, ...(resolution ? { resolution } : {}) } };
}
