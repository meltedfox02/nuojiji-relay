// 持久 outbox（Node，RELAY_STORE=sqlite）。手机长时间离线也能拉回（按 TTL 清扫）。
// 依赖 optionalDependencies 的 better-sqlite3；装不上时 outboxStore 工厂会回退到内存。

import { createRequire } from 'node:module';
import { DEFAULT_TTL_MS } from './outboxStore.js';

// 计算式 require：阻止 esbuild/wrangler 把 better-sqlite3(Node-only)静态打进 Workers bundle。
// 本文件只在 Node + RELAY_STORE=sqlite 时被动态加载，require 在 Node 下同步可用。
function loadSqlite() {
    const require = createRequire(import.meta.url);
    return require(['better', 'sqlite3'].join('-'));
}

export class SqliteOutboxStore {
    constructor(path = './outbox.db', ttlMs = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
        this.kind = 'sqlite';
        const Database = loadSqlite();
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS outbox (
                inboxId   TEXT NOT NULL,
                id        TEXT NOT NULL,
                requestId TEXT NOT NULL,
                charId    TEXT,
                roundId   TEXT,
                userId    TEXT,
                content   TEXT,
                error     TEXT,
                createdAt INTEGER NOT NULL,
                PRIMARY KEY (inboxId, id)
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_inbox_created ON outbox(inboxId, createdAt);
            CREATE TABLE IF NOT EXISTS req_seen (
                requestId TEXT PRIMARY KEY,
                createdAt INTEGER NOT NULL
            );
        `);
        this._timer = setInterval(() => this.sweep(), 60_000);
        if (this._timer.unref) this._timer.unref();
    }

    seenRequest(requestId) {
        const row = this.db.prepare('SELECT createdAt FROM req_seen WHERE requestId = ?').get(requestId);
        if (!row) return false;
        if (Date.now() - row.createdAt > this.ttlMs) {
            this.db.prepare('DELETE FROM req_seen WHERE requestId = ?').run(requestId);
            return false;
        }
        return true;
    }

    markRequest(requestId) {
        this.db.prepare('INSERT OR REPLACE INTO req_seen (requestId, createdAt) VALUES (?, ?)')
            .run(requestId, Date.now());
    }

    async put(inboxId, item) {
        this.db.prepare(`
            INSERT OR REPLACE INTO outbox (inboxId, id, requestId, charId, roundId, userId, content, error, createdAt)
            VALUES (@inboxId, @id, @requestId, @charId, @roundId, @userId, @content, @error, @createdAt)
        `).run({
            inboxId,
            id: item.id,
            requestId: item.requestId,
            charId: item.charId ?? null,
            roundId: item.roundId ?? null,
            userId: item.userId ?? null,
            content: item.content ?? null,
            error: item.error ?? null,
            createdAt: item.createdAt,
        });
        this.markRequest(item.requestId);
    }

    async list(inboxId, sinceTs = 0) {
        return this.db.prepare(
            'SELECT id, requestId, charId, roundId, userId, content, error, createdAt FROM outbox WHERE inboxId = ? AND createdAt > ? ORDER BY createdAt ASC'
        ).all(inboxId, sinceTs);
    }

    async ack(inboxId, ids = []) {
        if (!ids.length) return 0;
        const stmt = this.db.prepare('DELETE FROM outbox WHERE inboxId = ? AND id = ?');
        const tx = this.db.transaction((list) => {
            let n = 0;
            for (const id of list) n += stmt.run(inboxId, id).changes;
            return n;
        });
        return tx(ids);
    }

    sweep() {
        const cutoff = Date.now() - this.ttlMs;
        this.db.prepare('DELETE FROM outbox WHERE createdAt < ?').run(cutoff);
        this.db.prepare('DELETE FROM req_seen WHERE createdAt < ?').run(cutoff);
    }
}
