// Cloudflare Workers 入口。
// 部署：wrangler deploy（需在 wrangler.toml 绑定 KV namespace "OUTBOX"，
//      并 `wrangler secret put RELAY_SECRET` / VAPID_* 等）。

import { createApp } from './src/app.js';
import { runProactiveTick, shouldRunTickNow } from './src/proactive/tick.js';

const app = createApp();

export default {
    fetch: app.fetch,
    // Phase 2：定时主动生成。wrangler.toml [triggers] crons 配置触发频率。
    async scheduled(event, env, ctx) {
        // PROACTIVE_TICK_MINUTES=N → 每 N 分钟才真跑一轮，其余分钟直接返回（省 KV 额度）。
        if (!shouldRunTickNow(env, event?.scheduledTime)) return;
        ctx.waitUntil(
            runProactiveTick(env).catch((e) => console.error('[scheduled] proactive tick failed:', e?.message))
        );
    },
};
