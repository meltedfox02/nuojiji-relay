// 后端代理主动消息的「主动用 MCP 工具」tool-loop（移植自手机端 aiApiWithMcp.prefetchMcpToolResults
// 的 proactiveMode 分支）。角色主动开口前，先让一个 tool-routing agent 决策是否调工具（搜热搜/
// 新闻/天气等），把结果回填，让主生成有真实素材。
//
// 与手机端一致：决策 prompt 用「角色想主动找用户聊」视角、关键字 gating、Anthropic/OpenAI 两种格式、
// 多轮迭代、副 API 优先。工具列表(cachedTools)由手机端随注册下发，后端不自己 listTools。
//
// ⚠️ 受 tick 墙钟预算约束：tool-loop 是【额外多次串行 API 调用】，由 tick 传入 deadline，到点即停。

import { callTool } from '../mcp/mcpClient.js';
import { collectMcpTools, resolveToolCall, toAnthropicTools, toOpenAiTools, filterServersByKeywords } from '../mcp/mcpToolBridge.js';
import { buildChatEndpoint, buildApiHeaders, isAnthropicOfficialUrl, assertSafeApiUrl } from '../ai/requestBuilder.js';

const MAX_TOOL_ITERATIONS = 3;
const TOOL_CALL_TIMEOUT_MS = 30000;
const LLM_TIMEOUT_MS = 60000;

function mcpContentToText(content) {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const parts = [];
    for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        else if (b.type === 'image') parts.push('[image content omitted]');
        else if (b.type === 'resource') parts.push(`[resource: ${b.resource?.uri || 'unknown'}]`);
        else parts.push(JSON.stringify(b));
    }
    return parts.join('\n');
}

// 把 namespacedName 的 server 找回来（serversById 用 tool 的 serverId 反查注册下发的 server 规格）。
async function executeToolCall({ namespacedName, args, mcpTools, serversById, actor, errors }) {
    const resolved = resolveToolCall(namespacedName, mcpTools);
    if (!resolved) return `Error: tool ${namespacedName} not found`;
    const server = serversById.get(resolved.serverId);
    if (!server) return `Error: server for tool ${namespacedName} not found`;
    // actor 注入（自部署记忆 MCP 按角色 namespace 用），不覆盖 AI 已给的 _actor
    let finalArgs = args;
    if (server.passActor && actor && (actor.characterId || actor.userId)) {
        const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        if (!base._actor) finalArgs = { ...base, _actor: actor };
    }
    try {
        assertSafeApiUrl(server.url); // SSRF 防护（同 callTool 内，双保险）
        const { content, isError } = await callTool(server, resolved.toolName, finalArgs, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
        const text = mcpContentToText(content);
        if (isError) {
            errors.push({ serverName: server.name, message: text.slice(0, 200) });
            return `Error from ${resolved.toolName}: ${text}`;
        }
        return text;
    } catch (e) {
        const msg = e?.message || String(e);
        errors.push({ serverName: server.name, message: msg });
        return `Error calling ${resolved.toolName}: ${msg}`;
    }
}

async function llmCall({ chatUrl, apiKey, model, body, signal, deadline }) {
    const headers = buildApiHeaders(chatUrl, apiKey);
    const controller = new AbortController();
    // 超时取 min(单调用上限, 距 deadline 剩余)：避免在 deadline 前夕起的调用还能跑满 60s 冲过预算。
    const budget = typeof deadline === 'number' ? Math.max(1000, deadline - Date.now()) : LLM_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), Math.min(LLM_TIMEOUT_MS, budget));
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
        const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        if (!res.ok) throw new Error(`tool-decision API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const data = await res.json();
        if (data.error) throw new Error(`tool-decision error: ${data.error.message || data.error.type}`);
        return data;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

const DECISION_SYSTEM = (toolsManifest) => `You are a tool-routing agent acting on behalf of a chat character who is about to message the user on their own initiative (the user has NOT asked anything — the character just feels like reaching out). Your only output is either a tool call or the literal string NO_TOOLS.

Available tools:
${toolsManifest}

CALL a tool when fresh external info would make the character's upcoming message more interesting, timely, or genuine — even though nobody asked:
- The character might want to share or react to something current (trending topics, news, weather, prices, anything "latest")
- The character is curious and would naturally look something up before chatting about it
- Looking it up lets the character open with a concrete, real hook instead of a generic greeting
- When borderline, prefer calling — the whole point of this mode is proactive, self-initiated tool use

Reply NO_TOOLS when:
- The character just wants to say something purely emotional/personal that needs no external facts
- Recent conversation context already gives the character enough to talk about
- Previous tool results in this thread already cover what's needed

Output contract:
- Each turn: emit ONE tool call OR the bare string NO_TOOLS
- If results from a previous call are enough, emit NO_TOOLS immediately
- Stay focused on routing — leave the user-facing message to the main agent`;

/**
 * 跑 proactive tool-loop，返回要拼进转录的「素材文本」(无工具被调用 → 空串)。
 * @param {Array} mcpToolServers  手机端注册下发的 action-mode server 规格（含 cachedTools）
 * @param {Array} recentMessages  后端滑窗（决策上下文 + 关键字 gating 用）
 * @param {object} aiSettings     {mainApiUrl,mainApiKey,mainApiModel,apiType,temperature, secondaryApiUrl,secondaryApiKey,secondaryApiModel, mcpUseSecondaryApi}
 * @param {object} ctx            { userId, characterId, deadline(ms epoch，到点即停) }
 * @returns {Promise<string>}     拼进 transcript 的素材文本（空串=没调工具）
 */
export async function runProactiveToolLoop(mcpToolServers, recentMessages, aiSettings, ctx = {}) {
    if (!Array.isArray(mcpToolServers) || mcpToolServers.length === 0) return '';
    const deadline = ctx.deadline || (Date.now() + 20000);
    if (Date.now() > deadline) return '';

    // 决策上下文：最近几条消息拼成文本（主动模式无「user 刚说的话」，用近况近似 + 关键字 gating）
    const recentText = (recentMessages || []).slice(-6)
        .map(m => `${(m.sender === 'me' || m.role === 'user') ? 'User' : 'Char'}: ${m.text || m.content || ''}`)
        .join('\n');

    // 关键字 gating（与手机端一致：没设关键字=永远生效）
    const activeServers = filterServersByKeywords(mcpToolServers, recentText);
    if (activeServers.length === 0) return '';
    const mcpTools = collectMcpTools(activeServers);
    if (mcpTools.length === 0) return '';
    const serversById = new Map(activeServers.map(s => [s.id, s]));

    // 副 API 优先（省主 model token）；与手机端 resolveApiForPrefetch 同语义
    const useSec = aiSettings?.mcpUseSecondaryApi && aiSettings?.secondaryApiUrl && aiSettings?.secondaryApiKey;
    const apiUrl = useSec ? aiSettings.secondaryApiUrl : aiSettings?.mainApiUrl;
    const apiKey = useSec ? aiSettings.secondaryApiKey : aiSettings?.mainApiKey;
    const model = useSec ? (aiSettings.secondaryApiModel || aiSettings?.mainApiModel) : aiSettings?.mainApiModel;
    if (!apiUrl || !apiKey) return '';
    assertSafeApiUrl(apiUrl);
    const chatUrl = buildChatEndpoint(apiUrl);
    const isAnthropic = isAnthropicOfficialUrl(apiUrl);
    const temperature = typeof aiSettings?.temperature === 'number' ? aiSettings.temperature : undefined;
    const actor = ctx.characterId != null ? { characterId: String(ctx.characterId), userId: ctx.userId != null ? String(ctx.userId) : undefined } : null;

    const toolsManifest = mcpTools.map(t => `  - ${t.namespacedName}: ${t.description || '(no description)'}`).join('\n');
    const decisionSystem = DECISION_SYSTEM(toolsManifest);
    const errors = [];
    const collected = []; // [{server, tool, args, result}]

    try {
        if (isAnthropic) {
            let working = [{ role: 'user', content: recentText || '(no recent context — decide whether fresh info would help the character open the conversation)' }];
            for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
                if (Date.now() > deadline) break;
                const data = await llmCall({
                    chatUrl, apiKey, model, deadline,
                    body: {
                        model, system: decisionSystem, messages: working,
                        max_tokens: 1024, ...(temperature != null ? { temperature } : {}),
                        tools: toAnthropicTools(mcpTools),
                    },
                });
                if (data.stop_reason !== 'tool_use') break;
                const blocks = Array.isArray(data.content) ? data.content : [];
                working.push({ role: 'assistant', content: blocks });
                const toolUses = blocks.filter(b => b.type === 'tool_use');
                const results = await Promise.all(toolUses.map(async (tu) => {
                    const text = await executeToolCall({ namespacedName: tu.name, args: tu.input || {}, mcpTools, serversById, actor, errors });
                    const r = resolveToolCall(tu.name, mcpTools);
                    collected.push({ server: r?.serverName || '?', tool: r?.toolName || tu.name, args: tu.input, result: text });
                    return { tool_use_id: tu.id, text };
                }));
                working.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })) });
            }
        } else {
            let working = [
                { role: 'system', content: decisionSystem },
                { role: 'user', content: recentText || '(no recent context — decide whether fresh info would help the character open the conversation)' },
            ];
            for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
                if (Date.now() > deadline) break;
                const data = await llmCall({
                    chatUrl, apiKey, model, deadline,
                    body: {
                        model, messages: working,
                        ...(temperature != null ? { temperature } : {}),
                        tools: toOpenAiTools(mcpTools), tool_choice: 'auto',
                    },
                });
                const choice = data.choices?.[0];
                const msg = choice?.message;
                const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
                if (choice?.finish_reason !== 'tool_calls' && toolCalls.length === 0) break;
                working.push({ role: 'assistant', content: msg?.content || null, tool_calls: toolCalls });
                const results = await Promise.all(toolCalls.map(async (tc) => {
                    let args = {};
                    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
                    const text = await executeToolCall({ namespacedName: tc.function?.name, args, mcpTools, serversById, actor, errors });
                    const r = resolveToolCall(tc.function?.name, mcpTools);
                    collected.push({ server: r?.serverName || '?', tool: r?.toolName || tc.function?.name, args, result: text });
                    return { id: tc.id, text };
                }));
                for (const r of results) working.push({ role: 'tool', tool_call_id: r.id, content: r.text });
            }
        }
    } catch (e) {
        console.warn('[proactiveToolLoop] failed:', e?.message || e);
        return ''; // 失败静默降级，不挡主动消息生成
    }

    if (collected.length === 0) return '';
    const lines = ['\n\n[MCP Tool Results — auto-fetched, use as factual basis for what you bring up]'];
    for (const c of collected) {
        const argStr = (() => { try { return JSON.stringify(c.args); } catch { return String(c.args); } })();
        const clipped = c.result.length > 4000 ? c.result.slice(0, 4000) + '\n…[truncated]' : c.result;
        lines.push(`\n— ${c.server}.${c.tool}(${argStr}):\n${clipped}`);
    }
    return lines.join('\n');
}
