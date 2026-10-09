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

import { resolveTtlMs } from './outboxStore.js';

export class KvOutboxStore {
    constructor(kv, env) {
        this.kv = kv;
        this.kind = 'kv';
        // TTL 可由 env.OUTBOX_TTL_MIN 覆盖（默认 6h）。索引剪枝与 KV expirationTtl 都用它。
        this.ttlMs = resolveTtlMs(env);
        this.ttlSec = Math.floor(this.ttlMs / 1000);
    }

    async seenRequest(requestId) {
        const v = await this.kv.get(`r:${requestId}`);
        return v != null;
    }

    async markRequest(requestId) {
        await this.kv.put(`r:${requestId}`, '1', { expirationTtl: this.ttlSec });
    }

    async _getIndex(inboxId) {
        const raw = await this.kv.get(`idx:${inboxId}`);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }

    async _putIndex(inboxId, idx) {
        // 索引也按 TTL 过期；顺手剔除超 TTL 的条目，防止无限增长
        const cutoff = Date.now() - this.ttlMs;
        const pruned = idx.filter((e) => e.createdAt > cutoff);
        await this.kv.put(`idx:${inboxId}`, JSON.stringify(pruned), { expirationTtl: this.ttlSec });
    }

    async put(inboxId, item) {
        await this.kv.put(`o:${inboxId}:${item.id}`, JSON.stringify(item), { expirationTtl: this.ttlSec });
        const idx = await this._getIndex(inboxId);
        // 去重（同 id 不重复追加）
        if (!idx.some((e) => e.id === item.id)) idx.push({ id: item.id, createdAt: item.createdAt });
        await this._putIndex(inboxId, idx);
        await this.markRequest(item.requestId);
    }

    async list(inboxId, sinceTs = 0) {
        // ⚠️ 不能只信索引 idx:<inboxId>：put() 的「读索引→push→写索引」是非原子 read-modify-write，
        //    KV 无事务。两个 put 并发（如用户回复 + 同对 proactive tick，或连发两条）会互相覆盖索引：
        //    A 读到[]、B 读到[]、A 写[A]、B 写[B] → A 的索引条目丢失，但 o:inbox:A 数据还在 →
        //    list 永远返回不了 A → 「推送弹了、点进去没消息」（与网络无关，自有域名用户也中招）。
        //    修：除了走索引，再用 kv.list({prefix}) 兜底扫一遍 o:<inboxId>: 实际存在的 item key，
        //    两路按 id 去重合并。索引(强一致)抓最新刚 put 的；prefix-list(最终一致)抓被索引覆盖丢的。
        const idx = await this._getIndex(inboxId);
        const idIndex = new Map(); // id → createdAt（合并两路来源）
        for (const e of idx) {
            if (e && e.id != null) idIndex.set(e.id, e.createdAt || 0);
        }
        // 兜底：列出真实存在的 item key，补回索引漏掉的（idx 竞态丢失 / 索引本身过期但 item 未过期）
        try {
            const prefix = `o:${inboxId}:`;
            let cursor;
            do {
                const res = await this.kv.list({ prefix, cursor });
                for (const k of (res?.keys || [])) {
                    const id = k.name.slice(prefix.length);
                    if (!idIndex.has(id)) idIndex.set(id, 0); // createdAt 未知 → 0，下面读 item 拿真值
                }
                cursor = res?.list_complete ? null : res?.cursor;
            } while (cursor);
        } catch { /* list 失败（权限/限频）→ 退回只用索引，至少不更糟 */ }

        const out = [];
        for (const [id] of idIndex) {
            const raw = await this.kv.get(`o:${inboxId}:${id}`); // 强一致 get
            if (!raw) continue; // item 已过期被 KV 清 → 跳过；ack/prune 会清索引
            let item;
            try { item = JSON.parse(raw); } catch { continue; /* skip corrupt */ }
            // 用 item 自带的真 createdAt 过滤 since（索引里的可能是兜底的 0）
            if ((item.createdAt || 0) > sinceTs) out.push(item);
        }
        out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
