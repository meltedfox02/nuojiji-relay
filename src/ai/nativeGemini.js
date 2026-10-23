const GEMINI_API_TYPE = 'gemini';

export function isNativeGemini(apiType, apiUrl) {
    if (apiType !== GEMINI_API_TYPE || !apiUrl) return false;
    let pathname;
    try { pathname = new URL(apiUrl).pathname.replace(/\/+$/, ''); } catch { return false; }
    // An explicitly configured OpenAI-compatible endpoint keeps the existing protocol.
    if (/(?:\/openai|\/chat\/completions|\/responses)$/i.test(pathname)) return false;
    // Preserve the established Gemini-via-OpenAI convention for a generic /v1 base.
    // Native Gemini v1 can be selected explicitly with its full models/{model}:method URL.
    if (/\/v1$/i.test(pathname)) return false;
    return true;
}

export function buildGeminiEndpoint(apiUrl, model) {
    const url = new URL(apiUrl);
    let path = url.pathname.replace(/\/+$/, '');
    const fullMethod = /^(.*\/models\/[^/]+):(generateContent|streamGenerateContent)$/i.exec(path);
    if (fullMethod) {
        path = `${fullMethod[1]}:streamGenerateContent`;
    } else {
        if (!/\/v1(?:beta)?$/i.test(path)) path = `${path}/v1beta`;
        const modelName = String(model || '').replace(/^models\//i, '');
        if (!modelName) throw new Error('Gemini model is required when apiUrl does not include a full models method URL');
        path = `${path}/models/${encodeURIComponent(modelName)}:streamGenerateContent`;
    }
    url.pathname = path;
    url.searchParams.set('alt', 'sse');
    return url.toString();
}

export function buildGeminiHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
    };
}

function toGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) {
        if (content == null) return [];
        throw new Error('Unsupported Gemini message content; expected text or OpenAI content parts');
    }

    const parts = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            if (typeof part === 'string' && part) parts.push({ text: part });
            continue;
        }
        if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ text: part.text });
            continue;
        }
        if (part.type === 'image_url') {
            const imageUrl = part.image_url?.url || part.image_url || part.url;
            const match = typeof imageUrl === 'string'
                ? /^data:([^;,]+);base64,([\s\S]+)$/i.exec(imageUrl)
                : null;
            if (!match) throw new Error('Native Gemini supports only base64 data URL images; remote images are unsupported');
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            continue;
        }
        throw new Error(`Unsupported Gemini message part: ${part.type || 'unknown'}`);
    }
    return parts;
}

export function buildGeminiRequestBody({ messages, temperature, maxTokens }) {
    const contents = [];
    const systemParts = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message) continue;
        const role = String(message.role || '').toLowerCase();
        if (role === 'tool' || role === 'function' || message.tool_calls || message.function_call) {
            throw new Error('Native Gemini does not support tool messages or tool calls');
        }
        const parts = toGeminiParts(message.content);
        if (!parts.length) continue;
        if (role === 'system' || role === 'developer') {
            if (parts.some((part) => typeof part.text !== 'string')) {
                throw new Error('Native Gemini system instructions support text only');
            }
            systemParts.push(...parts.map((part) => part.text || ''));
        } else {
            contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
        }
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Please continue.' }] });

    const maxOutputTokens = maxTokens ? Math.min(maxTokens, 65_536) : undefined;
    const generationConfig = {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
    };
    return {
        ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } } : {}),
        contents,
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
}

export function parseGeminiResponse(data) {
    if (data?.error) throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((part) => !part?.thought && typeof part?.text === 'string').map((part) => part.text).join('');
    const reasoning = parts.filter((part) => part?.thought && typeof part?.text === 'string').map((part) => part.text).join('');
    return { content, reasoning: reasoning || null };
}
