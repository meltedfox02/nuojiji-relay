// Hono app —— 一份代码，Workers 和 Node 共用。
//
// 路由：
//   GET  /health                 健康检查（设置页测连接用）
//   POST /generate               提交生成（fire-and-forget，202）
//   GET  /outbox?inboxId=&since=  拉取已生成结果
//   POST /ack                    确认并删除
//   GET  /api/push/vapid-key     取 VAPID 公钥（复用 APP 现有订阅流程）
//   POST /api/push/subscribe     注册推送订阅
//   DELETE /api/push/unsubscribe 退订

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore } from './store/subStore.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from './store/proactiveStore.js';
import { runGeneration } from './ai/aiCaller.js';
import { dispatchPush } from './push/pushSender.js';
import { getVapidPublicKey } from './push/webPush.js';
import { makeMessageId, nowMs } from './util/ids.js';

const VERSION = '1.0.0';

export function createApp() {
    const app = new Hono();

    // 中继是用户自己的后端，APP 从套壳 (https://localhost / capacitor://localhost) 或
    // 网页 (https://*.pages.dev) 跨域请求 → 放开 CORS（鉴权靠 Bearer secret，不靠 origin）。
    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    // 每个请求懒初始化 store（Workers 每次 fetch 都新 env；Node 进程级缓存见下）
    const stores = { outbox: null, sub: null, proactive: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            // Workers：KV 绑定每次都现取，store 实例无状态可重建
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                proactive: await createProactiveStore(env),
            };
        }
        // Node：进程级单例
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.proactive) stores.proactive = await createProactiveStore(env);
        return stores;
    }

    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    // 🔧 临时调试端点：浏览器直接访问，验证 Worker 是否能写/读 KV + 出站请求是否可用。
    //    GET /debug-ping  → 写一条测试 item 进 outbox(inboxId=debug) 再读回，返回结果。
    //    确认链路后应删除。无需鉴权（仅诊断，不含敏感操作）。
    app.get('/debug-ping', async (c) => {
        const out = { version: VERSION, steps: {} };
        try {
            const { outbox } = await getStores(c.env);
            out.steps.storeKind = outbox.kind;
            const id = 'debug_' + nowMs();
            await outbox.put('debug', { id, requestId: id, content: 'kv-write-ok', createdAt: nowMs() });
            out.steps.kvPut = 'ok';
            const items = await outbox.list('debug', 0);
            out.steps.kvList = items.length;
            await outbox.ack('debug', [id]);
            out.steps.kvAck = 'ok';
        } catch (e) {
            out.steps.error = String(e?.message || e);
        }
        // 测出站请求（Worker 能不能访问外网，AI 调用的前提）
        try {
            const r = await fetch('https://api.openai.com/v1/models', { method: 'GET' });
            out.steps.outboundFetch = `reachable (HTTP ${r.status})`;
        } catch (e) {
            out.steps.outboundFetch = 'FAILED: ' + String(e?.message || e);
        }
        return c.json(out);
    });

    // 🔧 临时调试：同步跑一次生成，把结果/完整错误直接返回（不走 waitUntil/outbox）。
    //    POST 和 /generate 一样的 body。用来定位「202 成功但 outbox 空」= 后台 AI 调用为何无产出。
    //    需 Bearer secret（会用到真 key）。确认后删除。
    app.post('/debug-generate', requireSecret, async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { messages, settings, maxTokens } = body || {};
        if (!Array.isArray(messages) || !settings) return c.json({ error: 'messages/settings required' }, 400);
        try {
            const content = await runGeneration(settings, messages, maxTokens || null);
            return c.json({ ok: true, contentPreview: String(content).slice(0, 300), len: String(content).length });
        } catch (e) {
            return c.json({ ok: false, error: String(e?.message || e), status: e?.status, detail: e?.detail });
        }
        return c.json(out);
    });

    // 以下全部要鉴权
    app.use('/generate', requireSecret);
    app.use('/outbox', requireSecret);
    app.use('/ack', requireSecret);
    app.use('/api/push/subscribe', requireSecret);
    app.use('/api/push/unsubscribe', requireSecret);
    app.use('/proactive/*', requireSecret);

    app.post('/generate', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'requestId / inboxId / messages / settings required' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);

        // 幂等：同 requestId 在 TTL 内只处理一次
        if (await outbox.seenRequest(requestId)) {
            return c.json({ duplicate: true, requestId }, 409);
        }
        await outbox.markRequest(requestId);

        // ⚠️ 在请求生命周期内「同步」跑完生成 + 写 outbox，再返回。
        //    早期用 c.executionCtx.waitUntil 在响应后跑后台任务，但 Cloudflare 免费版 Workers 对
        //    waitUntil 的 CPU/时长有严格配额，AI 调用(数秒~十几秒)常被掐断 → outbox 永远空。
        //    手机端是 fire-and-forget + 轮询，不在乎 /generate 响应快慢，故改同步等待最可靠。
        const id = makeMessageId(requestId);
        let item;
        try {
            const content = await runGeneration(settings, messages, maxTokens);
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content, error: null, createdAt: nowMs(),
            };
        } catch (e) {
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content: null, error: String(e?.message || e), createdAt: nowMs(),
            };
        }
        await outbox.put(inboxId, item);
        // 🔧 诊断：写入后立即自查一次，确认 put 真的进了同一 inbox（排查 inboxId 不匹配/KV 写入失败）
        let _selfCheck = -1;
        try { _selfCheck = (await outbox.list(inboxId, 0)).length; } catch { /* ignore */ }

        // 发叫醒推送（best-effort，丢了靠手机轮询补）。推送可放 waitUntil（轻量，丢了也无妨）。
        const pushWork = (async () => {
            try {
                const subs = await sub.list(inboxId);
                const payload = {
                    title: '糯叽机',
                    body: item.error ? '生成失败，点开查看' : '有新消息',
                    charId: item.charId, userId: item.userId, kind: 'relay-outbox',
                };
                for (const s of subs) {
                    const res = await dispatchPush(c.env, s, payload);
                    if (res?.gone) await sub.remove(inboxId, s);
                }
            } catch (e) {
                console.warn('[generate] push failed:', e?.message);
            }
        })();
        try {
            if (typeof c.executionCtx?.waitUntil === 'function') c.executionCtx.waitUntil(pushWork);
            else pushWork.catch(() => {});
        } catch { pushWork.catch(() => {}); }

        // outbox 已写入，返回（手机轮询会拉到）。202 语义保留。
        // _selfCheck = 写入后自查同 inbox 的条数；inboxId 回显用于对比手机查询的 inboxId。
        return c.json({ accepted: true, requestId, generated: !item.error, inboxId, selfCheck: _selfCheck, itemId: id, err: item.error || null }, 202);
    });

    app.get('/outbox', async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, since);
        return c.json({ items, now: nowMs() });
    });

    app.post('/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, ids } = body || {};
        if (!inboxId || !Array.isArray(ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        const { outbox } = await getStores(c.env);
        const acked = await outbox.ack(inboxId, ids);
        return c.json({ acked });
    });

    app.get('/api/push/vapid-key', async (c) => {
        const publicKey = getVapidPublicKey(c.env);
        if (!publicKey) return c.json({ error: 'VAPID not configured' }, 503);
        return c.json({ publicKey });
    });

    app.post('/api/push/subscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, channel } = body || {};
        if (!inboxId || !subscription) return c.json({ error: 'inboxId / subscription required' }, 400);
        const { sub } = await getStores(c.env);
        // 默认 web 通道（PWA）；apns/fcm 由套壳显式带 channel
        const entry = subscription.channel ? subscription : { channel: channel || 'web', sub: subscription };
        await sub.add(inboxId, entry);
        return c.json({ ok: true });
    });

    app.delete('/api/push/unsubscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, endpoint } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        await sub.remove(inboxId, subscription || { endpoint });
        return c.json({ ok: true });
    });

    // ===== Phase 2：后端代理主动消息 =====

    // 注册/更新一对的全量配置（含手机端拼好的 promptTemplate）
    app.post('/proactive/register', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const {
            inboxId, userId, charId, promptTemplate, proactiveProfile, lifeState,
            intensity, proactiveBias, recentMessages, aiSettings, quietHours,
            charUtcOffsetSeconds, proactiveEnabledAt, lastInteractionAt, enabled,
            mode, interval, intervalUnit, probability,
        } = body || {};
        if (!inboxId || userId == null || charId == null || !promptTemplate || !aiSettings) {
            return c.json({ error: 'inboxId / userId / charId / promptTemplate / aiSettings required' }, 400);
        }
        const { proactive } = await getStores(c.env);
        await proactive.upsert({
            inboxId, userId: String(userId), charId: String(charId),
            mode: mode === 'interval' ? 'interval' : 'impulse',
            interval: interval ?? 60, intervalUnit: intervalUnit || 'minutes', probability: probability || 'medium',
            promptTemplate, proactiveProfile: proactiveProfile || null, lifeState: lifeState || {},
            intensity: intensity || 'normal', proactiveBias: proactiveBias || 0,
            recentMessages: Array.isArray(recentMessages) ? recentMessages.slice(-PROACTIVE_WINDOW_CAP) : [],
            aiSettings, quietHours: quietHours || null,
            charUtcOffsetSeconds: charUtcOffsetSeconds ?? null,
            proactiveEnabledAt: proactiveEnabledAt || Date.now(),
            lastInteractionAt: lastInteractionAt || 0,
            enabled: enabled !== false,
        });
        return c.json({ ok: true });
    });

    // 增量同步滑窗消息 + lifeState + lastInteractionAt（整窗替换，无 delta）
    app.post('/proactive/sync-messages', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId, recentMessages, lifeState, lastInteractionAt } = body || {};
        if (!inboxId || userId == null || charId == null) {
            return c.json({ error: 'inboxId / userId / charId required' }, 400);
        }
        const { proactive } = await getStores(c.env);
        const patch = {};
        if (Array.isArray(recentMessages)) patch.recentMessages = recentMessages.slice(-PROACTIVE_WINDOW_CAP);
        if (lifeState) patch.lifeState = lifeState;
        if (typeof lastInteractionAt === 'number') patch.lastInteractionAt = lastInteractionAt;
        const ok = await proactive.patch(inboxId, String(userId), String(charId), patch);
        if (!ok) return c.json({ error: 'pair not registered' }, 404);
        return c.json({ ok: true });
    });

    app.post('/proactive/unregister', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        const { proactive } = await getStores(c.env);
        await proactive.remove(inboxId, String(userId), String(charId));
        return c.json({ ok: true });
    });

    app.get('/proactive/status', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const rows = await proactive.listByInbox(inboxId);
        // 不回 promptTemplate/key 等敏感内容，只回状态
        return c.json({
            pairs: rows.map(r => ({
                userId: r.userId, charId: r.charId, enabled: r.enabled,
                windowSize: (r.recentMessages || []).length,
                lastFiredAt: r.lastFiredAt || 0, updatedAt: r.updatedAt,
            })),
        });
    });

    return app;
}
