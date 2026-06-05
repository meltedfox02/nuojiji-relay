// Cloudflare KV outbox（Workers）。KV 自带 expirationTtl 自动清理。
//
// ⚠️ KV 的 list() 是「最终一致」——刚 put 的 key 经常 list 不出来（全球同步延迟），
//    会导致手机刚生成的消息拉不到。但按 key 直接 get() 是强一致的。
//    所以这里不靠 list 扫 key，改为每个 inbox 维护一个索引 key `idx:<inboxId>`
//    （存 [{id, createdAt}] 数组），读取时 get 索引再逐个 get item —— 全程走强一致的 get。
//
// key 设计：
//   索引: `idx:<inboxId>`            → JSON [{id, createdAt}, ...]
//   item: `o:<inboxId>:<id>`         → JSON item
//   reqId: `r:<requestId>`           → 去重标记

import { DEFAULT_TTL_MS } from './outboxStore.js';

const TTL_SEC = Math.floor(DEFAULT_TTL_MS / 1000);

export class KvOutboxStore {
    constructor(kv) {
        this.kv = kv;
        this.kind = 'kv';
    }

    async seenRequest(requestId) {
        const v = await this.kv.get(`r:${requestId}`);
        return v != null;
    }

    async markRequest(requestId) {
        await this.kv.put(`r:${requestId}`, '1', { expirationTtl: TTL_SEC });
    }

    async _getIndex(inboxId) {
        const raw = await this.kv.get(`idx:${inboxId}`);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }

    async _putIndex(inboxId, idx) {
        // 索引也按 TTL 过期；顺手剔除超 TTL 的条目，防止无限增长
        const cutoff = Date.now() - DEFAULT_TTL_MS;
        const pruned = idx.filter((e) => e.createdAt > cutoff);
        await this.kv.put(`idx:${inboxId}`, JSON.stringify(pruned), { expirationTtl: TTL_SEC });
    }

    async put(inboxId, item) {
        await this.kv.put(`o:${inboxId}:${item.id}`, JSON.stringify(item), { expirationTtl: TTL_SEC });
        const idx = await this._getIndex(inboxId);
        // 去重（同 id 不重复追加）
        if (!idx.some((e) => e.id === item.id)) idx.push({ id: item.id, createdAt: item.createdAt });
        await this._putIndex(inboxId, idx);
        await this.markRequest(item.requestId);
    }

    async list(inboxId, sinceTs = 0) {
        const idx = await this._getIndex(inboxId);
        const wanted = idx.filter((e) => e.createdAt > sinceTs).sort((a, b) => a.createdAt - b.createdAt);
        const out = [];
        for (const e of wanted) {
            const raw = await this.kv.get(`o:${inboxId}:${e.id}`);
            if (raw) {
                try { out.push(JSON.parse(raw)); } catch { /* skip corrupt */ }
            }
            // raw 为 null = item 已过期被 KV 清，但索引还在 → 下面 list 时不返回；ack/prune 会清索引
        }
        return out;
    }

    async ack(inboxId, ids = []) {
        let n = 0;
        const idSet = new Set(ids);
        for (const id of ids) {
            await this.kv.delete(`o:${inboxId}:${id}`);
            n++;
        }
        const idx = await this._getIndex(inboxId);
        const remaining = idx.filter((e) => !idSet.has(e.id));
        await this._putIndex(inboxId, remaining);
        return n;
    }

    sweep() { /* KV TTL 自动清理 */ }
}
