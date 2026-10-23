// 服务端 AI 调用 —— 复刻 APP 本地路径的非流式行为（含主→副 fallback、429 退避）。
// 内部流式读取 AI 输出，完整结果再写入 outbox 交给手机。

import { getApiConfig, extractStreamReasoning, extractReasoning } from './apiConfigs.js';
import { buildChatEndpoint, buildApiHeaders, buildChatRequestBody, assertSafeApiUrl } from './requestBuilder.js';
import {
    buildGeminiEndpoint, buildGeminiHeaders, buildGeminiRequestBody,
    isNativeGemini, parseGeminiResponse,
} from './nativeGemini.js';

// 空闲超时（不是总时长）：连续这么久一个字节都没收到才判定连接挂死。
//   早期是 180s 总超时 → GLM 等长思考模型推理超过 3 分钟就被后端自己掐断，token 已扣却拿不到结果，
//   手机端再回退本地 = 同一轮扣两次费。流式下思考期间 reasoning delta 持续到达，不会误触。
const IDLE_TIMEOUT_MS = 600_000;
// 原生推理可能很长（数万字），outbox 存储有体积上限 → 封顶；手机端只用于思维链面板展示
const REASONING_CAP = 20_000;

function capReasoning(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    return t.length > REASONING_CAP ? t.slice(0, REASONING_CAP) + '…' : t;
}

async function callOnce({ apiUrl, apiKey, model, apiType, messages, temperature, reasoningEffort, maxTokens }) {
    assertSafeApiUrl(apiUrl);
    const nativeGemini = isNativeGemini(apiType, apiUrl);
    const endpoint = nativeGemini ? buildGeminiEndpoint(apiUrl, model) : buildChatEndpoint(apiUrl);
    const headers = nativeGemini ? buildGeminiHeaders(apiKey) : buildApiHeaders(apiUrl, apiKey);
    // ⚠️ 用流式调 AI（stream:true）：部分 AI 代理（如 gemini 反代）对「非流式 + 图片」会 500，
    //    流式正常。后端在请求内读完整个 SSE 流、把 delta 拼成完整 content 再返回 —— 对手机端
    //    仍是「整条结果进 outbox」的非流式交付，只是后端内部走流式绕开代理的非流式限制。
    const body = nativeGemini
        ? buildGeminiRequestBody({ messages, temperature, maxTokens })
        : buildChatRequestBody({ apiUrl, model, messages, temperature, reasoningEffort, stream: true, maxTokens });

    const controller = new AbortController();
    let timer = null;
    const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    kick();
    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            const err = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 500)}`);
            err.status = res.status;
            throw err;
        }

        const config = getApiConfig(apiType);
        const ct = res.headers.get('content-type') || '';

        // 非 SSE（代理忽略了 stream，直接返回完整 JSON）→ 按非流式解析兜底
        if (!ct.includes('text/event-stream')) {
            const rawText = await res.text();
            let data;
            try { data = JSON.parse(rawText); } catch { data = rawText; }
            if (nativeGemini) {
                const parsed = parseGeminiResponse(data);
                if (!parsed.content || !parsed.content.trim()) {
                    const err = new Error('AI returned empty content (non-stream fallback)');
                    err.status = res.status;
                    throw err;
                }
                return { content: parsed.content, reasoning: capReasoning(parsed.reasoning) };
            }
            const content = config.extractContent(data);
            if (content == null || content === '') {
                const err = new Error('AI returned empty content (non-stream fallback)');
                err.status = res.status;
                err.detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
                throw err;
            }
            return { content, reasoning: capReasoning(extractReasoning(data)) };
        }

        // Native Gemini SSE events can contain several data lines and several parts.
        // Keep its error and thought handling separate from the legacy OpenAI-compatible parser.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let reasoning = '';
        let eventName = '';
        let eventData = [];
        const dispatchGeminiEvent = () => {
            if (!eventData.length) { eventName = ''; return; }
            const payload = eventData.join('\n');
            eventData = [];
            const name = eventName;
            eventName = '';
            if (payload.trim() === '[DONE]') return;
            let json;
            try { json = JSON.parse(payload); } catch {
                if (name === 'error') throw new Error(`Gemini API error: ${payload.slice(0, 500)}`);
                return;
            }
            if (name === 'error' || json?.error) {
                throw new Error(`Gemini API error: ${json?.error?.message || JSON.stringify(json.error || json).slice(0, 500)}`);
            }
            const parsed = parseGeminiResponse(json);
            content += parsed.content;
            if (parsed.reasoning) reasoning += parsed.reasoning;
        };
        const consumeGeminiLine = (line) => {
            if (line === '') { dispatchGeminiEvent(); return; }
            if (line.startsWith(':')) return;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'event') eventName = value;
            else if (field === 'data') eventData.push(value);
        };
        const drainGeminiLines = (flush = false) => {
            let start = 0;
            for (let i = 0; i < buffer.length; i++) {
                const code = buffer.charCodeAt(i);
                if (code !== 10 && code !== 13) continue;
                if (code === 13 && i === buffer.length - 1 && !flush) break;
                consumeGeminiLine(buffer.slice(start, i));
                if (code === 13 && buffer.charCodeAt(i + 1) === 10) i++;
                start = i + 1;
            }
            buffer = buffer.slice(start);
            if (flush && buffer) {
                consumeGeminiLine(buffer);
                buffer = '';
            }
        };
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    buffer += decoder.decode();
                    if (nativeGemini) {
                        drainGeminiLines(true);
                        dispatchGeminiEvent();
                    } else if (buffer.trim().startsWith('data:')) {
                        const payload = buffer.trim().slice(5).trim();
                        if (payload !== '[DONE]') {
                            let json;
                            try { json = JSON.parse(payload); } catch { json = null; }
                            if (json) {
                                const delta = config.extractStreamDelta(json);
                                if (delta) content += delta;
                                const rDelta = extractStreamReasoning(json);
                                if (rDelta) reasoning += rDelta;
                            }
                        }
                    }
                    break;
                }
                kick(); // 收到数据 → 重置空闲计时
                buffer += decoder.decode(value, { stream: true });
                if (nativeGemini) {
                    drainGeminiLines();
                    continue;
                }
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 末行可能不完整，留到下次
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === '[DONE]') continue;
                    let json;
                    try { json = JSON.parse(payload); } catch { continue; }
                    const delta = config.extractStreamDelta(json);
                    if (delta) content += delta;
                    const rDelta = extractStreamReasoning(json);
                    if (rDelta) reasoning += rDelta;
                }
            }
        } catch (error) {
            if (nativeGemini) await reader.cancel(error).catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
        if (!content || !content.trim()) {
            const err = new Error('AI returned empty content (stream)');
            err.status = res.status;
            throw err;
        }
        return { content, reasoning: capReasoning(reasoning) };
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一次完整生成：主 API（带 429 退避重试）→ 失败且开了副 API fallback → 副 API。
 * @returns {Promise<{content:string, reasoning:string|null}>} 原始模型文本（含 tag，手机端解析）+ 原生推理
 */
export async function runGeneration(settings, messages, maxTokens) {
    const {
        mainApiUrl, mainApiKey, mainApiModel, apiType = 'openai',
        temperature, reasoningEffort,
        autoRetryEnabled = true, maxRetries = 1, secondaryFallbackEnabled = true,
        secondaryApiUrl, secondaryApiKey, secondaryApiModel,
    } = settings || {};

    if (!mainApiUrl || !mainApiKey) throw new Error('settings.mainApiUrl / mainApiKey missing');

    const retries = autoRetryEnabled ? Math.max(0, Math.min(3, Number(maxRetries) || 0)) : 0;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
        try {
            return await callOnce({
                apiUrl: mainApiUrl, apiKey: mainApiKey, model: mainApiModel, apiType,
                messages, temperature, reasoningEffort, maxTokens,
            });
        } catch (e) {
            lastErr = e;
            // 只对 429 退避重试，其余错误立即跳出（避免重复扣费）
            if (e.status !== 429) break;
        }
    }

    // 主 API 失败 → 副 API fallback
    if (secondaryFallbackEnabled && secondaryApiUrl && secondaryApiKey) {
        try {
            return await callOnce({
                apiUrl: secondaryApiUrl, apiKey: secondaryApiKey, model: secondaryApiModel || mainApiModel, apiType,
                messages, temperature, reasoningEffort, maxTokens,
            });
        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('AI generation failed');
}
