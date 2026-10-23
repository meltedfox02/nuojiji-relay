// Web Push (VAPID + aes128gcm) —— 纯 Web Crypto 实现，Workers 和 Node 18+ 通用。
// 不依赖 `web-push` 库（它需要 Node 的 http/https，Workers 打包会炸）。
//
// 推送只是「叫醒」信号，payload 极小（title/body/charId/userId/kind）。
//
// 环境变量：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（base64url 裸 EC P-256 密钥）/ VAPID_SUBJECT(mailto:)
//   生成：npx web-push generate-vapid-keys（只用它生成密钥，运行时不依赖该库）

const enc = new TextEncoder();

function b64urlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64url(bytes) {
    let bin = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrs) {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}

// VAPID 密钥来源优先级：环境变量 > KV 自动生成（一键部署零操作）> 内存生成（Node 无 KV 时）。
// 自动生成：VAPID 本质是一对 EC P-256 密钥，用 Web Crypto 现生成、裸 base64url 存 KV(`vapid:keys`)，之后复用。
const VAPID_KV_KEY = 'vapid:keys';
let _memVapid = null; // Node 无 KV 时的进程内缓存

function envVapid(env) {
    const pub = env?.VAPID_PUBLIC_KEY || (typeof process !== 'undefined' ? process.env?.VAPID_PUBLIC_KEY : '');
    const priv = env?.VAPID_PRIVATE_KEY || (typeof process !== 'undefined' ? process.env?.VAPID_PRIVATE_KEY : '');
    if (pub && priv) {
        const subject = env?.VAPID_SUBJECT || (typeof process !== 'undefined' ? process.env?.VAPID_SUBJECT : '') || 'mailto:relay@example.com';
        return { pub, priv, subject };
    }
    return null;
}

// 现生成一对 VAPID 密钥（裸格式：pub=65B 04||x||y base64url，priv=32B d base64url）
async function generateVapidPair() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)); // 65B
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return { pub: bytesToB64url(rawPub), priv: jwk.d }; // jwk.d 已是 base64url 的 32B 私钥
}

// 取（或自动生成）VAPID。env.OUTBOX 是 KV（Workers）；Node 无 KV 用内存缓存。
async function getVapid(env) {
    const fromEnv = envVapid(env);
    if (fromEnv) return fromEnv;
    const subject = env?.VAPID_SUBJECT || (typeof process !== 'undefined' ? process.env?.VAPID_SUBJECT : '') || 'mailto:relay@example.com';

    const kv = env?.OUTBOX;
    if (kv && typeof kv.get === 'function') {
        const raw = await kv.get(VAPID_KV_KEY);
        if (raw) {
            try { const k = JSON.parse(raw); if (k.pub && k.priv) return { ...k, subject }; } catch { /* regenerate */ }
        }
        const gen = await generateVapidPair();
        await kv.put(VAPID_KV_KEY, JSON.stringify(gen));
        return { ...gen, subject };
    }

    // Node 无 KV：进程内缓存（重启会换密钥，已订阅需重订；建议 Node 部署仍配 env VAPID）
    if (!_memVapid) _memVapid = await generateVapidPair();
    return { ..._memVapid, subject };
}

export async function getVapidPublicKey(env) {
    const v = await getVapid(env);
    return v?.pub || '';
}

// 把裸 EC 私钥 (32B d) + 公钥 (65B 04||x||y) 导入成可签名的 CryptoKey（JWK 方式）
async function importVapidKey(pubB64, privB64) {
    const pub = b64urlToBytes(pubB64);   // 65B: 0x04 || X(32) || Y(32)
    const d = b64urlToBytes(privB64);    // 32B
    const x = bytesToB64url(pub.slice(1, 33));
    const y = bytesToB64url(pub.slice(33, 65));
    return crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y, d: bytesToB64url(d), ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
}

// 生成 VAPID JWT（ES256），用于 Authorization: vapid
async function makeVapidJwt(endpoint, vapid) {
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const payload = bytesToB64url(enc.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
    const signingInput = `${header}.${payload}`;
    const key = await importVapidKey(vapid.pub, vapid.priv);
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        enc.encode(signingInput)
    );
    // Web Crypto 返回 raw r||s (64B)，JWT 也要 raw → 直接 base64url
    return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// HKDF
async function hkdf(salt, ikm, info, length) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        key,
        length * 8
    );
    return new Uint8Array(bits);
}

// aes128gcm 加密 payload（RFC 8291）
async function encryptPayload(plaintext, subscription) {
    const uaPub = b64urlToBytes(subscription.keys.p256dh); // 65B
    const authSecret = b64urlToBytes(subscription.keys.auth); // 16B

    // 本地临时 ECDH 密钥对
    const localPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const localPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', localPair.publicKey)); // 65B

    const uaPubKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, localPair.privateKey, 256);
    const ecdhSecret = new Uint8Array(sharedBits);

    const salt = crypto.getRandomValues(new Uint8Array(16));

    // PRK_key = HKDF(auth, ecdhSecret, "WebPush: info\0" || uaPub || localPub, 32)
    const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPub, localPubRaw);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

    // 明文 + padding delimiter 0x02（最后一条记录）
    const padded = concatBytes(plaintext, new Uint8Array([0x02]));
    const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

    // aes128gcm header: salt(16) || rs(4, big-endian 4096) || idlen(1)=65 || keyid(65=localPub)
    const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]);
    const header = concatBytes(salt, rs, new Uint8Array([localPubRaw.length]), localPubRaw);
    return concatBytes(header, ct);
}

/**
 * 发一条 web push。subscription = 浏览器 PushSubscription.toJSON()。
 * 返回 { ok, gone, reason }。gone:true 表示订阅失效（410/404），调用方应删除。
 */
export async function sendWebPush(env, subscription, payload) {
    const vapid = await getVapid(env);
    if (!vapid) return { ok: false, gone: false, reason: 'vapid-not-configured' };
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return { ok: false, gone: true, reason: 'invalid-subscription' };
    }
    try {
        const body = await encryptPayload(enc.encode(JSON.stringify(payload)), subscription);
        const jwt = await makeVapidJwt(subscription.endpoint, vapid);
        const res = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `vapid t=${jwt}, k=${vapid.pub}`,
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                'TTL': '60',
            },
            body,
        });
        if (res.status === 201 || res.status === 200) return { ok: true, gone: false };
        if (res.status === 404 || res.status === 410) return { ok: false, gone: true, reason: `gone ${res.status}` };
        // 4xx 客户端错误（订阅本身已废：endpoint/密钥失效、记录损坏）也当 gone 删除，
        // 只放过 429(限流，稍后重试)。否则坏订阅会永远赖在 sub.list 里，每次推送都 400。
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            return { ok: false, gone: true, reason: `bad-subscription ${res.status}` };
        }
        return { ok: false, gone: false, reason: `HTTP ${res.status}` };
    } catch (e) {
        return { ok: false, gone: false, reason: e?.message || String(e) };
    }
}
