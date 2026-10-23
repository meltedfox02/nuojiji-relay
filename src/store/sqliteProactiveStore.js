// 持久主动状态（Node，RELAY_STORE=sqlite）。整条 record 以 JSON 存一列，简单可靠。

import { createRequire } from 'node:module';
import { makePairKey } from './proactiveStore.js';

// 计算式 require：阻止 esbuild/wrangler 把 better-sqlite3(Node-only)静态打进 Workers bundle。
function loadSqlite() {
    const require = createRequire(import.meta.url);
    return require(['better', 'sqlite3'].join('-'));
}

export class SqliteProactiveStore {
    constructor(path = './outbox.db') {
        this.kind = 'sqlite';
        const Database = loadSqlite();
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS proactive (
                pairKey  TEXT PRIMARY KEY,
                inboxId  TEXT NOT NULL,
                enabled  INTEGER NOT NULL DEFAULT 0,
                data     TEXT NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_proactive_enabled ON proactive(enabled);
            CREATE INDEX IF NOT EXISTS idx_proactive_inbox ON proactive(inboxId);
            CREATE TABLE IF NOT EXISTS proactive_pause (
                inboxId     TEXT PRIMARY KEY,
                pausedUntil INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS proactive_fire (
                pairKey     TEXT PRIMARY KEY,
                lastFiredAt INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tick_lock (
                id        INTEGER PRIMARY KEY CHECK (id = 1),
                lockUntil INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tick_cursor (
                id     INTEGER PRIMARY KEY CHECK (id = 1),
                cursor INTEGER NOT NULL
            );
        `);
    }
    async getTickCursor() {
        const row = this.db.prepare('SELECT cursor FROM tick_cursor WHERE id = 1').get();
        return row ? Number(row.cursor) || 0 : 0;
    }
    async setTickCursor(n) {
        this.db.prepare('INSERT OR REPLACE INTO tick_cursor (id, cursor) VALUES (1, ?)').run(Number(n) || 0);
    }
    // 🔒 lastFiredAt 独立表（与 data blob 的 patch 分开）：防 sync-messages 覆盖 cron 抢槽 = 重复主动消息。
    async claimFire(inboxId, userId, charId, now) {
        this.db.prepare('INSERT OR REPLACE INTO proactive_fire (pairKey, lastFiredAt) VALUES (?,?)')
            .run(makePairKey(inboxId, userId, charId), now || Date.now());
        return true;
    }
    // 🔒 条件抢占（CAS，防两轮重叠 cron 同一对双发）。better-sqlite3 同步执行，进程内真原子。
    async claimFireIfStale(inboxId, userId, charId, now, cooldownMs) {
        const key = makePairKey(inboxId, userId, charId);
        const row = this.db.prepare('SELECT lastFiredAt FROM proactive_fire WHERE pairKey = ?').get(key);
        const prev = row ? Number(row.lastFiredAt) || 0 : 0;
        if (prev && (now - prev) < cooldownMs) return false;
        this.db.prepare('INSERT OR REPLACE INTO proactive_fire (pairKey, lastFiredAt) VALUES (?,?)')
            .run(key, now || Date.now());
        return true;
    }
    async getLastFired(inboxId, userId, charId) {
        const row = this.db.prepare('SELECT lastFiredAt FROM proactive_fire WHERE pairKey = ?')
            .get(makePairKey(inboxId, userId, charId));
        return row ? Number(row.lastFiredAt) || 0 : 0;
    }
    // 🔒 tick 重入锁（node-cron 已有 _ticking 兜底，这里与 KV 接口对齐多一层）
    async acquireTickLock(ttlMs = 120000) {
        const row = this.db.prepare('SELECT lockUntil FROM tick_lock WHERE id = 1').get();
        if (row && Number(row.lockUntil) > Date.now()) return false;
        this.db.prepare('INSERT OR REPLACE INTO tick_lock (id, lockUntil) VALUES (1, ?)').run(Date.now() + ttlMs);
        return true;
    }
    async releaseTickLock() { this.db.prepare('DELETE FROM tick_lock WHERE id = 1').run(); }
    _mergeFire(rec) {
        const row = this.db.prepare('SELECT lastFiredAt FROM proactive_fire WHERE pairKey = ?')
            .get(makePairKey(rec.inboxId, rec.userId, rec.charId));
        if (row) rec.lastFiredAt = Number(row.lastFiredAt) || 0;
        return rec;
    }
    // inbox 级暂停：走线下剧情时手机端调 /proactive/pause，tick 跳过该 inbox 的所有 pair。
    async setPause(inboxId, pausedUntil) {
        if (pausedUntil && pausedUntil > Date.now()) {
            this.db.prepare('INSERT OR REPLACE INTO proactive_pause (inboxId, pausedUntil) VALUES (?,?)')
                .run(inboxId, pausedUntil);
        } else {
            this.db.prepare('DELETE FROM proactive_pause WHERE inboxId = ?').run(inboxId);
        }
    }
    async getPausedUntil(inboxId) {
        const row = this.db.prepare('SELECT pausedUntil FROM proactive_pause WHERE inboxId = ?').get(inboxId);
        const until = row ? Number(row.pausedUntil) : 0;
        if (until && until <= Date.now()) {
            this.db.prepare('DELETE FROM proactive_pause WHERE inboxId = ?').run(inboxId);
            return 0;
        }
        return until;
    }
    async upsert(rec) {
        const key = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const prevRow = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(key);
        const prev = prevRow ? JSON.parse(prevRow.data) : {};
        const merged = { ...prev, ...rec, updatedAt: rec.updatedAt || Date.now() };
        this.db.prepare(
            'INSERT OR REPLACE INTO proactive (pairKey, inboxId, enabled, data, updatedAt) VALUES (?,?,?,?,?)'
        ).run(key, merged.inboxId, merged.enabled ? 1 : 0, JSON.stringify(merged), merged.updatedAt);
    }
    async patch(inboxId, userId, charId, patch) {
        const key = makePairKey(inboxId, userId, charId);
        const row = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(key);
        if (!row) return false;
        const merged = { ...JSON.parse(row.data), ...patch, updatedAt: Date.now() };
        this.db.prepare('UPDATE proactive SET enabled=?, data=?, updatedAt=? WHERE pairKey=?')
            .run(merged.enabled ? 1 : 0, JSON.stringify(merged), merged.updatedAt, key);
        return true;
    }
    async remove(inboxId, userId, charId) {
        const k = makePairKey(inboxId, userId, charId);
        this.db.prepare('DELETE FROM proactive WHERE pairKey = ?').run(k);
        this.db.prepare('DELETE FROM proactive_fire WHERE pairKey = ?').run(k);
    }
    async listEnabled() {
        return this.db.prepare('SELECT data FROM proactive WHERE enabled = 1').all().map(r => this._mergeFire(JSON.parse(r.data)));
    }
    async listByInbox(inboxId) {
        return this.db.prepare('SELECT data FROM proactive WHERE inboxId = ?').all(inboxId).map(r => this._mergeFire(JSON.parse(r.data)));
    }
    async get(inboxId, userId, charId) {
        const row = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(makePairKey(inboxId, userId, charId));
        return row ? this._mergeFire(JSON.parse(row.data)) : null;
    }
}