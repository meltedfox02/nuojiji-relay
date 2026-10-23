import test from 'node:test';
import assert from 'node:assert/strict';
import { runGeneration } from '../src/ai/aiCaller.js';
import { buildGeminiEndpoint, buildGeminiRequestBody, isNativeGemini } from '../src/ai/nativeGemini.js';
import { buildChatEndpoint } from '../src/ai/requestBuilder.js';

const originalFetch = globalThis.fetch;

function streamResponse(chunks, contentType = 'text/event-stream') {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    }), { status: 200, headers: { 'content-type': contentType } });
}

function byteStreamResponse(chunks) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function settings(overrides = {}) {
    return {
        mainApiUrl: 'https://gemini.example/v1beta',
        mainApiKey: 'test-key',
        mainApiModel: 'gemini-2.5-flash',
        apiType: 'gemini',
        autoRetryEnabled: false,
        secondaryFallbackEnabled: false,
        ...overrides,
    };
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('native Gemini URL builder supports origin, version base, and full method URL', () => {
    assert.equal(
        buildGeminiEndpoint('https://gemini.example', 'gemini-2.5-flash'),
        'https://gemini.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    assert.equal(
        buildGeminiEndpoint('https://gemini.example/v1', 'gemini-2.5-flash'),
        'https://gemini.example/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    assert.equal(
        buildGeminiEndpoint('https://gemini.example/v1beta/models/gemini-2.5-flash:generateContent', 'ignored'),
        'https://gemini.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    assert.equal(
        buildGeminiEndpoint('https://gemini.example/v1beta', 'models/gemini-test'),
        'https://gemini.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
    );
    assert.throws(() => buildGeminiEndpoint('https://gemini.example/v1beta'), /Gemini model is required/);
    assert.equal(isNativeGemini('gemini', 'https://gemini.example/v1beta/openai'), false);
    assert.equal(isNativeGemini('gemini', 'https://gemini.example/v1'), false);
    assert.equal(isNativeGemini('gemini', 'https://gemini.example/v1/models/gemini-2.5-flash:generateContent'), true);
    assert.equal(isNativeGemini('openai', 'https://gemini.example/v1beta'), false);
    assert.equal(buildChatEndpoint('https://compat.example/v1/chat/completions'), 'https://compat.example/v1/chat/completions');
});

test('native Gemini maps roles, system text, images, temperature, and output tokens', () => {
    const body = buildGeminiRequestBody({
        model: 'gemini-2.5-flash', temperature: 0.4, maxTokens: 70000,
        messages: [
            { role: 'system', content: '保持原文 Unicode：你好🌿' },
            { role: 'developer', content: 'Be concise' },
            { role: 'user', content: [
                { type: 'text', text: '看这张图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
            ] },
            { role: 'assistant', content: '已看过。' },
        ],
    });
    assert.deepEqual(body, {
        systemInstruction: { parts: [{ text: '保持原文 Unicode：你好🌿\n\nBe concise' }] },
        contents: [
            { role: 'user', parts: [{ text: '看这张图' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
            { role: 'model', parts: [{ text: '已看过。' }] },
        ],
        generationConfig: { temperature: 0.4, maxOutputTokens: 65536 },
    });
    assert.throws(() => buildGeminiRequestBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img.example/a.png' } }] }] }), /remote images are unsupported/);
    assert.throws(() => buildGeminiRequestBody({ messages: [{ role: 'assistant', tool_calls: [{}], content: '' }] }), /tool messages or tool calls/);
    assert.throws(() => buildGeminiRequestBody({ messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }), /system instructions support text only/);
});

test('runGeneration sends native auth and body, and parses all SSE parts including thought deltas', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
        request = { url, headers: init.headers, body: JSON.parse(init.body) };
        return streamResponse([
            'data: {\r\ndata: "candidates":[{"content":{"parts":[{"text":"你好"},{"text":"思路","thought":true},{"text":"，🌏"}]}}]}\r\n\r\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}',
        ]);
    };
    const result = await runGeneration(settings({ mainApiUrl: 'https://gemini.example' }), [{ role: 'user', content: '你好' }], 128);
    assert.match(request.url, /^https:\/\/gemini\.example\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
    assert.equal(request.headers['x-goog-api-key'], 'test-key');
    assert.equal(request.headers.Authorization, undefined);
    assert.deepEqual(request.body, {
        contents: [{ role: 'user', parts: [{ text: '你好' }] }],
        generationConfig: { maxOutputTokens: 128 },
    });
    assert.deepEqual(result, { content: '你好，🌏!', reasoning: '思路' });
});

test('native Gemini stream decodes split UTF-8 bytes and CRLF boundaries', async () => {
    const bytes = new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"你好🌏"}]}}]}\r\n\r\n');
    const unicodeStart = bytes.indexOf(0xf0);
    const crIndex = bytes.indexOf(13);
    globalThis.fetch = async () => byteStreamResponse([
        bytes.slice(0, unicodeStart + 1),
        bytes.slice(unicodeStart + 1, crIndex + 1),
        bytes.slice(crIndex + 1),
    ]);
    const result = await runGeneration(settings(), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, '你好🌏');
});

test('native Gemini in-band SSE errors fail even after a content event', async () => {
    globalThis.fetch = async () => streamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
        'event: error\ndata: {"error":{"message":"quota exhausted"}}\n\n',
    ]);
    await assert.rejects(runGeneration(settings(), [{ role: 'user', content: 'hello' }]), /Gemini API error: quota exhausted/);
});

test('native Gemini cancels the response stream when an in-band error arrives', async () => {
    let canceled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('event: error\ndata: {"error":{"message":"stop"}}\n\n')); },
        cancel() { canceled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(runGeneration(settings(), [{ role: 'user', content: 'hello' }]), /Gemini API error: stop/);
    assert.equal(canceled, true);
});

test('fallback uses the secondary URL protocol and legacy OpenAI-compatible routes stay intact', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        if (requests.length === 1) return new Response('unavailable', { status: 503 });
        return streamResponse(['data: {"choices":[{"delta":{"content":"fallback ok"}}]}\n\n']);
    };
    const result = await runGeneration(settings({
        secondaryFallbackEnabled: true,
        secondaryApiUrl: 'https://compat.example/v1beta/openai',
        secondaryApiKey: 'secondary-key',
        secondaryApiModel: 'gpt-test',
    }), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'fallback ok');
    assert.match(requests[0].url, /:streamGenerateContent\?alt=sse$/);
    assert.equal(requests[1].url, 'https://compat.example/v1beta/openai/chat/completions');
    assert.equal(requests[1].headers.Authorization, 'Bearer secondary-key');
    assert.equal(requests[1].headers['x-goog-api-key'], undefined);
    assert.equal(requests[1].body.model, 'gpt-test');
    assert.equal(requests[1].body.stream, true);
});

test('OpenAI apiType keeps the existing endpoint, Bearer auth, and stream body', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
        request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return streamResponse(['data: {"choices":[{"delta":{"content":"legacy ok"}}]}\n\n']);
    };
    const result = await runGeneration(settings({
        apiType: 'openai', mainApiUrl: 'https://openai.example/v1', mainApiKey: 'openai-key',
    }), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'legacy ok');
    assert.equal(request.url, 'https://openai.example/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer openai-key');
    assert.equal(request.body.stream, true);
});

test('Custom apiType keeps the existing OpenAI-compatible protocol', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
        request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return streamResponse(['data: {"choices":[{"delta":{"content":"custom ok"}}]}\n\n']);
    };
    const result = await runGeneration(settings({
        apiType: 'custom', mainApiUrl: 'https://custom.example/v1', mainApiKey: 'custom-key',
    }), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'custom ok');
    assert.equal(request.url, 'https://custom.example/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer custom-key');
});

test('Gemini API type with a generic /v1 base preserves legacy OpenAI-compatible behavior', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
        request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return streamResponse(['data: {"choices":[{"delta":{"content":"legacy gemini proxy"}}]}\n\n']);
    };
    const result = await runGeneration(settings({ mainApiUrl: 'https://compat.example/v1' }), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'legacy gemini proxy');
    assert.equal(request.url, 'https://compat.example/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
});

test('native Gemini parses JSON fallback and rejects thought-only output as empty content', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [
        { content: { parts: [{ text: 'A' }, { text: 'B' }] } },
        { content: { parts: [{ text: 'alternate candidate must be ignored' }] } },
    ] }), {
        status: 200, headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(await runGeneration(settings(), [{ role: 'user', content: 'hello' }]), { content: 'AB', reasoning: null });

    globalThis.fetch = async () => streamResponse(['data: {"candidates":[{"content":{"parts":[{"text":"internal","thought":true}]}}]}\n\n']);
    await assert.rejects(runGeneration(settings(), [{ role: 'user', content: 'hello' }]), /AI returned empty content/);
});

test('Anthropic requests keep the official API headers', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
        request = { url: String(url), headers: init.headers };
        return streamResponse(['event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"claude ok"}}\n\n']);
    };
    const result = await runGeneration(settings({
        apiType: 'claude', mainApiUrl: 'https://api.anthropic.com', mainApiKey: 'claude-key', mainApiModel: 'claude-test',
    }), [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'claude ok');
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.headers['x-api-key'], 'claude-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.headers.Authorization, undefined);
});
