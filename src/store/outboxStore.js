// Outbox 存储接口 + 工厂。
//
// item 形状：
//   { id, requestId, charId, roundId, userId, content, error, createdAt }
//
// 实现：
//   - Workers：KV（自带 expirationTtl，无需手动 sweep）          见 kvOutboxStore.js
//   - Node 默认：内存 Map + 定时 sweep                          见 memoryOutboxStore.js
//   - Node 持久（RELAY_STORE=sqlite）：better-sqlite3            见 sqliteOutboxStore.js
//
// TTL 默认 6 小时（手机离线/没排水超过这个时长，结果会被清掉 → 丢失）。
//   从 45min 调大到 6h：大陆用户常隔很久才打开 App（且中继域名可能时通时不通），45min 太短，
//   一觉醒来 outbox 已被清 = 「推送有、点进去没消息」的次因。可用环境变量 OUTBOX_TTL_MIN 覆盖。
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// 从 env 解析 TTL（分钟）→ 毫秒；非法/缺省回退 DEFAULT_TTL_MS。KV expirationTtl 最低 60s。
export function resolveTtlMs(env) {
    const min = parseInt(env?.OUTBOX_TTL_MIN, 10);
    if (Number.isFinite(min) && min > 0) return Math.max(60 * 1000, min * 60 * 1000);
    return DEFAULT_TTL_MS;
}

// 同时跟踪 requestId 去重：已处理过的 requestId 在 TTL 内拒绝重复 /generate（返回 409）。
// 各实现内部维护一个 requestId→createdAt 的小表。

// Node 进程级单例：HTTP 路由与 cron tick 必须共享同一实例（否则 tick 写的 outbox 路由读不到）。
let _nodeSingleton = null;

export async function createOutboxStore(env) {
    // Workers 环境：env.OUTBOX 是 KV 绑定（本就共享，不缓存）
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        const { KvOutboxStore } = await import('./kvOutboxStore.js');
        return new KvOutboxStore(env.OUTBOX, env);
    }

    // Node 环境
    if (_nodeSingleton) return _nodeSingleton;
    const storeKind = (typeof process !== 'undefined' && process.env?.RELAY_STORE) || 'memory';
    if (storeKind === 'sqlite') {
        try {
            // 计算式路径：阻止 esbuild/wrangler 把 sqlite store(及 better-sqlite3)静态打进 Workers bundle。
            const mod = await import(/* @vite-ignore */ './sqliteOutboxStore' + '.js');
            _nodeSingleton = new mod.SqliteOutboxStore(process.env.RELAY_SQLITE_PATH || './outbox.db');
            return _nodeSingleton;
        } catch (e) {
            console.warn('[outbox] sqlite 不可用，回退到内存:', e?.message);
        }
    }
    const { MemoryOutboxStore } = await import('./memoryOutboxStore.js');
    _nodeSingleton = new MemoryOutboxStore();
    return _nodeSingleton;
}
