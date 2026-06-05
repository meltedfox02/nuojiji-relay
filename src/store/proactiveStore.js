// 主动消息状态存储（Phase 2）—— 按 pair 持久化后端代理主动生成所需的全部状态。
//
// pairKey = `${inboxId}:${userId}:${charId}`
// record  = {
//   inboxId, userId, charId,
//   promptTemplate,          // 手机端拼好的完整 system prompt，含 {{RECENT_MESSAGES}} / {{IMPULSE_REASON}} 占位
//   proactiveProfile,        // 纯数值 profile（weights/threshold/quietHours/...）
//   lifeState,               // {moodIntensity, pendingUserQuestion, lastImpulseAt, lastProactiveSentAt, chitchatCooldownUntil, ...}
//   intensity, proactiveBias,
//   recentMessages,          // 滑窗（cap 30），整窗替换
//   aiSettings,              // {mainApiUrl, mainApiKey, mainApiModel, apiType, temperature, maxTokens?}
//   quietHours, charUtcOffsetSeconds,
//   proactiveEnabledAt,
//   lastInteractionAt,
//   lastFiredAt,             // 后端上次 cron 触发发送时间（防重复 + 简单冷却）
//   enabled, updatedAt,
// }
//
// 🔒 promptTemplate 是手机端拼好的文本，后端只 String.replaceAll 占位符，不含任何提示词逻辑。

export const PROACTIVE_WINDOW_CAP = 30;
// 后端 cron 触发后的最小静默（防 1 分钟 cron 连发；与手机端冷却独立）
export const BACKEND_FIRE_COOLDOWN_MS = 20 * 60 * 1000;

export function makePairKey(inboxId, userId, charId) {
    return `${inboxId}:${String(userId)}:${String(charId)}`;
}

// Node 进程级单例：HTTP 路由和 cron tick 必须共享同一个内存/sqlite 实例，
// 否则各拿各的新实例 → 注册的数据 tick 看不到。Workers 每次 fetch 新 env，KV 本就共享，不缓存。
let _nodeSingleton = null;

export async function createProactiveStore(env) {
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        return new KvProactiveStore(env.OUTBOX);
    }
    if (_nodeSingleton) return _nodeSingleton;
    const storeKind = (typeof process !== 'undefined' && process.env?.RELAY_STORE) || 'memory';
    if (storeKind === 'sqlite') {
        try {
            // 计算式路径：阻止 esbuild/wrangler 把 sqlite store(及其 better-sqlite3 依赖)静态打进 Workers bundle。
            // 该文件只在 Node + RELAY_STORE=sqlite 时才加载。
            const mod = await import(/* @vite-ignore */ './sqliteProactiveStore' + '.js');
            _nodeSingleton = new mod.SqliteProactiveStore(process.env.RELAY_SQLITE_PATH || './outbox.db');
            return _nodeSingleton;
        } catch (e) {
            console.warn('[proactive] sqlite 不可用，回退内存:', e?.message);
        }
    }
    _nodeSingleton = new MemoryProactiveStore();
    return _nodeSingleton;
}

// ===== 内存实现（Node 默认）=====
export class MemoryProactiveStore {
    constructor() { this.kind = 'memory'; this.map = new Map(); }
    async upsert(rec) {
        const key = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const prev = this.map.get(key) || {};
        this.map.set(key, { ...prev, ...rec, updatedAt: rec.updatedAt || Date.now() });
    }
    async patch(inboxId, userId, charId, patch) {
        const key = makePairKey(inboxId, userId, charId);
        const prev = this.map.get(key);
        if (!prev) return false;
        this.map.set(key, { ...prev, ...patch, updatedAt: Date.now() });
        return true;
    }
    async remove(inboxId, userId, charId) { this.map.delete(makePairKey(inboxId, userId, charId)); }
    async listEnabled() { return [...this.map.values()].filter(r => r.enabled); }
    async listByInbox(inboxId) { return [...this.map.values()].filter(r => r.inboxId === inboxId); }
    async get(inboxId, userId, charId) { return this.map.get(makePairKey(inboxId, userId, charId)) || null; }
}

// ===== Cloudflare KV 实现 =====
// key 前缀 `p:`；listEnabled 扫全前缀（pair 数量有限，可接受）
// ⚠️ 不用 kv.list(最终一致,刚注册的对 cron 可能扫不到)，改维护全局索引 key `pidx`(强一致 get)。
class KvProactiveStore {
    constructor(kv) { this.kv = kv; this.kind = 'kv'; }
    async _getIdx() {
        const raw = await this.kv.get('pidx');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }
    async _putIdx(keys) { await this.kv.put('pidx', JSON.stringify(keys)); }
    async _addToIdx(pairKey) {
        const idx = await this._getIdx();
        if (!idx.includes(pairKey)) { idx.push(pairKey); await this._putIdx(idx); }
    }
    async _removeFromIdx(pairKey) {
        const idx = await this._getIdx();
        const next = idx.filter((k) => k !== pairKey);
        if (next.length !== idx.length) await this._putIdx(next);
    }
    async upsert(rec) {
        const pairKey = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const key = `p:${pairKey}`;
        const prevRaw = await this.kv.get(key);
        const prev = prevRaw ? JSON.parse(prevRaw) : {};
        await this.kv.put(key, JSON.stringify({ ...prev, ...rec, updatedAt: rec.updatedAt || Date.now() }));
        await this._addToIdx(pairKey);
    }
    async patch(inboxId, userId, charId, patch) {
        const key = `p:${makePairKey(inboxId, userId, charId)}`;
        const prevRaw = await this.kv.get(key);
        if (!prevRaw) return false;
        const prev = JSON.parse(prevRaw);
        await this.kv.put(key, JSON.stringify({ ...prev, ...patch, updatedAt: Date.now() }));
        return true;
    }
    async remove(inboxId, userId, charId) {
        const pairKey = makePairKey(inboxId, userId, charId);
        await this.kv.delete(`p:${pairKey}`);
        await this._removeFromIdx(pairKey);
    }
    async _all() {
        const idx = await this._getIdx();
        const out = [];
        for (const pairKey of idx) {
            const raw = await this.kv.get(`p:${pairKey}`);
            if (raw) { try { out.push(JSON.parse(raw)); } catch { /* skip */ } }
        }
        return out;
    }
    async listEnabled() { return (await this._all()).filter(r => r.enabled); }
    async listByInbox(inboxId) { return (await this._all()).filter(r => r.inboxId === inboxId); }
    async get(inboxId, userId, charId) {
        const raw = await this.kv.get(`p:${makePairKey(inboxId, userId, charId)}`);
        return raw ? JSON.parse(raw) : null;
    }
}