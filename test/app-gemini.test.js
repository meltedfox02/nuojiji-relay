import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';

function workerEnv() {
    const values = new Map();
    return {
        RELAY_SECRET: 'test-relay-secret',
        OUTBOX: {
            async get(key, options) {
                const value = values.get(key) ?? null;
                return value && options?.type === 'json' ? JSON.parse(value) : value;
            },
            async put(key, value) { values.set(key, value); },
            async delete(key) { values.delete(key); },
            async list({ prefix = '' } = {}) {
                return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
            },
        },
    };
}

const auth = { Authorization: 'Bearer test-relay-secret' };

function generationRequest(requestId) {
    return {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requestId, inboxId: 'test-inbox',
            messages: [{ role: 'system', content: 'Reply briefly.' }, { role: 'user', content: 'Hello' }],
            settings: {
                apiType: 'gemini', mainApiUrl: 'https://native.example/v1beta',
                mainApiKey: 'test-ai-key', mainApiModel: 'gemini-test',
                secondaryFallbackEnabled: false,
            },
        }),
    };
}

test('Worker generation calls native Gemini and delivers the completed message through outbox', async (t) => {
    const app = createApp();
    const env = workerEnv();
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"测试成功 🌏"}]}}]}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
        });
    });
    const health = await app.request('/health', {}, env);
    assert.equal((await health.json()).ok, true);
    const submitted = await app.request('/generate', generationRequest('success'), env);
    assert.equal(submitted.status, 202);
    assert.equal((await submitted.json()).generated, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://native.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-ai-key');
    const outbox = await app.request('/outbox?inboxId=test-inbox&scan=0', { headers: auth }, env);
    const { items } = await outbox.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].content, '测试成功 🌏');
    assert.equal(items[0].error, null);
    const replay = await app.request('/generate', generationRequest('success'), env);
    assert.equal((await replay.json()).replayed, true);
    assert.equal(calls.length, 1, 'replaying a delivered request must not issue another AI call');
});

test('Worker health can succeed while a tunnel error is stored as a failed generation', async (t) => {
    const app = createApp();
    const env = workerEnv();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response('error code: 1033', { status: 530 });
    });
    assert.equal((await (await app.request('/health', {}, env)).json()).ok, true);
    const submitted = await app.request('/generate', generationRequest('tunnel-error'), env);
    assert.equal((await submitted.json()).generated, false);
    assert.equal(calls, 1);
    const outbox = await app.request('/outbox?inboxId=test-inbox&scan=0', { headers: auth }, env);
    const { items } = await outbox.json();
    assert.equal(items[0].content, null);
    assert.match(items[0].error, /530.*1033/);
});
