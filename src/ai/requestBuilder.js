// 请求构建 —— 从糯叽机 APP 的 src/utils/aiApiService.js 端口过来。
// ⚠️ 与 nuojiji APP 的 aiApiService.js 保持同步：
//    buildApiEndpoint / isAnthropicOfficialUrl / buildApiHeaders /
//    normalizeMessagesForAnthropic / buildChatRequestBody / buildChatEndpoint /
//    normalizeTextContent。
//    APP 那边改了任意一处请求格式，这里都要跟着改，否则 openai/gemini/claude/custom
//    四种 apiType 在服务端的行为会和手机本地路径不一致。

import { isPrivateOrBannedHost } from '../util/auth.js';

export function isAnthropicOfficialUrl(apiUrl) {
    if (!apiUrl) return false;
    return /(^|\.)anthropic\.com/i.test(apiUrl);
}

function buildApiEndpoint(apiUrl, suffix) {
    if (!apiUrl) return '';
    let base = apiUrl.replace(/\/+$/, '');
    if (isAnthropicOfficialUrl(base)) {
        if (!/\/v\d+$/.test(base) && !base.includes('/v1')) {
            base = `${base}/v1`;
        }
        return `${base}${suffix}`;
    }
    if (base.includes('generativelanguage.googleapis.com')) {
        if (!base.includes('/v1beta/openai')) {
            base = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
        return `${base}${suffix}`;
    }
    if (base.endsWith('/v1')) {
        return `${base}${suffix}`;
    }
    return `${base}/v1${suffix}`;
}

export const buildChatEndpoint = (apiUrl) =>
    buildApiEndpoint(apiUrl, isAnthropicOfficialUrl(apiUrl) ? '/messages' : '/chat/completions');

export function buildApiHeaders(apiUrl, apiKey, extraHeaders = {}) {
    if (isAnthropicOfficialUrl(apiUrl)) {
        return {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION_LOCAL,
            ...extraHeaders,
        };
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
    };
}

const ANTHROPIC_API_VERSION_LOCAL = '2023-06-01';

function normalizeTextContent(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (Array.isArray(input)) {
        return input.map((item) => normalizeTextContent(item)).filter(Boolean).join('');
    }
    if (typeof input === 'object') {
        if (typeof input.text === 'string') return input.text;
        if (typeof input.output_text === 'string') return input.output_text;
        if (input.content != null) return normalizeTextContent(input.content);
        if (input.parts != null) return normalizeTextContent(input.parts);
        if (input.message?.content != null) return normalizeTextContent(input.message.content);
    }
    return '';
}

function normalizeMessagesForAnthropic(messages) {
    const normalized = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    const converted = [];

    for (const msg of normalized) {
        if (!msg) continue;
        const role = String(msg.role || '').toLowerCase();

        if (role === 'system') {
            const textContent = normalizeTextContent(msg.content || '');
            if (textContent) systemParts.push(textContent);
            continue;
        }

        let processedContent;
        if (Array.isArray(msg.content)) {
            const anthropicParts = [];
            for (const part of msg.content) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'text') {
                    if (part.text) anthropicParts.push({ type: 'text', text: part.text });
                } else if (part.type === 'image_url') {
                    const imageUrl = part.image_url?.url || part.url;
                    if (imageUrl) {
                        if (imageUrl.startsWith('data:')) {
                            const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                            if (matches) {
                                anthropicParts.push({
                                    type: 'image',
                                    source: { type: 'base64', media_type: matches[1], data: matches[2] },
                                });
                            }
                        } else {
                            anthropicParts.push({ type: 'image', source: { type: 'url', url: imageUrl } });
                        }
                    }
                }
            }
            if (anthropicParts.length > 0) processedContent = anthropicParts;
            else continue;
        } else {
            const textContent = normalizeTextContent(msg.content || '');
            if (!textContent) continue;
            processedContent = textContent;
        }

        converted.push({ role: role === 'assistant' ? 'assistant' : 'user', content: processedContent });
    }

    if (converted.length === 0) {
        converted.push({ role: 'user', content: 'Please continue.' });
    }

    return { messages: converted, system: systemParts.join('\n\n').trim() };
}

export function buildChatRequestBody({ apiUrl, model, messages, temperature, reasoningEffort, stream, maxTokens }) {
    const isAnthropic = isAnthropicOfficialUrl(apiUrl);
    if (isAnthropic) {
        const { messages: anthropicMessages, system } = normalizeMessagesForAnthropic(messages);
        const anthropicLimit = /claude-3-5|claude-3\.5/i.test(model) ? 8192
            : /claude-3/i.test(model) ? 4096
            : 16384;
        const safeMax = maxTokens ? Math.min(maxTokens, anthropicLimit) : anthropicLimit;
        return {
            model,
            messages: anthropicMessages,
            max_tokens: safeMax,
            ...(typeof temperature === 'number' ? { temperature } : {}),
            ...(system ? { system } : {}),
            ...(stream ? { stream: true } : {}),
        };
    }

    // 兜底：若只有 system（或空）消息，补一条 user 占位。走 gemini 反代时 system 不进 contents，
    //    contents 为空会被代理拒（contents is required）。与 Anthropic 分支的同款保护对齐。
    const hasNonSystem = Array.isArray(messages)
        && messages.some((m) => m && String(m.role || '').toLowerCase() !== 'system');
    const safeMessages = hasNonSystem
        ? messages
        : [...(Array.isArray(messages) ? messages : []), { role: 'user', content: '请开始回复。' }];
    const isO = /\b(o1|o3|o4)/i.test(model);
    const safeMaxTokens = maxTokens ? Math.min(maxTokens, isO ? 100_000 : 65_536) : null;
    const tokenPayload = safeMaxTokens
        ? (isO ? { max_completion_tokens: safeMaxTokens } : { max_tokens: safeMaxTokens })
        : {};
    return {
        model,
        messages: safeMessages,
        ...(!isO ? { temperature } : {}),
        ...(typeof stream === 'boolean' ? { stream } : {}),
        ...tokenPayload,
        ...(isO && reasoningEffort && reasoningEffort !== 'none' ? { reasoning_effort: reasoningEffort } : {}),
    };
}

// SSRF 防护：用户的 messages/key 由用户自己掌控，但仍校验目标 URL host 不是内网/元数据地址，
// 防止有人借中继实例探测部署环境内网。isPrivateOrBannedHost 见 util/auth.js。
export function assertSafeApiUrl(apiUrl) {
    let host;
    try {
        host = new URL(apiUrl).hostname;
    } catch {
        throw new Error('Invalid apiUrl');
    }
    // 本地调试 / 把 AI 服务跑在同机时，设 RELAY_ALLOW_PRIVATE_HOST=1 放行内网地址。
    const allowPrivate = typeof process !== 'undefined' && process.env?.RELAY_ALLOW_PRIVATE_HOST === '1';
    if (!allowPrivate && isPrivateOrBannedHost(host)) {
        throw new Error(`Refusing to call private/banned host: ${host}`);
    }
}
