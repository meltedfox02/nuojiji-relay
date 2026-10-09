// 鉴权 + SSRF 防护。

import { createMiddleware } from 'hono/factory';

/**
 * 每实例共享密钥校验：Authorization: Bearer <RELAY_SECRET>。
 * RELAY_SECRET 从环境读（Workers: c.env.RELAY_SECRET / Node: process.env.RELAY_SECRET）。
 * 没配 secret 视为配置错误，拒绝所有请求（不允许裸奔——任何人都能花用户的 AI key）。
 */
export const requireSecret = createMiddleware(async (c, next) => {
    const secret = c.env?.RELAY_SECRET || (typeof process !== 'undefined' ? process.env?.RELAY_SECRET : '');
    if (!secret) {
        return c.json({ error: 'RELAY_SECRET not configured on server' }, 500);
    }
    const auth = c.req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !timingSafeEqual(token, secret)) {
        return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
});

// 常量时间比较，避免计时侧信道
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * 拒绝内网 / 云元数据 / 本机地址，防止借中继探测部署环境内网（SSRF）。
 * 注意：DNS 重绑定无法在此完全防住，仅做 host 字面量层面的防护。
 */
export function isPrivateOrBannedHost(host) {
    if (!host) return true;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, ''); // 去 IPv6 方括号

    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
    // 云元数据
    if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;

    // IPv4 私网 / 环回 / 链路本地
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 127) return true;                 // 127.0.0.0/8
        if (a === 10) return true;                  // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;    // 192.168.0.0/16
        if (a === 169 && b === 254) return true;    // 169.254.0.0/16
        if (a === 0) return true;
    }
    // IPv6 唯一本地地址 fc00::/7、链路本地 fe80::
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe80:/.test(h)) return true;

    return false;
}
