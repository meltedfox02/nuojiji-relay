// MCP Tool Bridge（后端版，移植自手机端 src/utils/mcpToolBridge.js，逻辑一致）。
//
// 把手机端注册时下发的 action-mode MCP tool 规格转成各家 LLM 的 tool calling 格式，
// 并反向把 LLM 回传的 namespaced tool 名对应回 server + 原 tool 名。
// 后端不自己 listTools——工具列表(cachedTools)由手机端随注册带来，这里只做格式转换。

const TOOL_NAME_SEP = '__';
const PREFIX = 'mcp_';

function shortServerKey(serverId) {
    return String(serverId || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 8);
}

// 净化第三方 tool 的 JSON Schema（补齐各家 LLM 严格校验点，尤其 Gemini 反代要求 array 带 items）。
function sanitizeSchema(schema, seen) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => sanitizeSchema(s, seen));
    seen = seen || new WeakSet();
    if (seen.has(schema)) return schema;
    seen.add(schema);
    const out = { ...schema };
    if (out.type == null && out.properties && typeof out.properties === 'object') out.type = 'object';
    if (out.type === 'array') {
        if (out.items == null) out.items = { type: 'string' };
        else out.items = sanitizeSchema(out.items, seen);
    }
    if (out.type === 'object' || out.properties) {
        if (out.properties == null) out.properties = {};
        else if (typeof out.properties === 'object') {
            const props = {};
            for (const [k, v] of Object.entries(out.properties)) props[k] = sanitizeSchema(v, seen);
            out.properties = props;
        }
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(out[key])) out[key] = out[key].map(s => sanitizeSchema(s, seen));
    }
    return out;
}

function namespacedToolName(serverId, toolName) {
    return `${PREFIX}${shortServerKey(serverId)}${TOOL_NAME_SEP}${toolName}`;
}

/**
 * 从手机端下发的 mcpToolServers 规格攤平成 LLM 能消化的工具数组。
 * 每个 server: { id, name, url, auth, cachedTools:[{name,description,inputSchema}], enabledTools?, triggerKeywords? }
 */
export function collectMcpTools(servers) {
    const flat = [];
    for (const s of (servers || [])) {
        if (!Array.isArray(s?.cachedTools) || s.cachedTools.length === 0) continue;
        const allowList = Array.isArray(s.enabledTools) && s.enabledTools.length > 0 ? new Set(s.enabledTools) : null;
        for (const tool of s.cachedTools) {
            if (!tool?.name) continue;
            if (allowList && !allowList.has(tool.name)) continue;
            flat.push({
                serverId: s.id,
                serverName: s.name,
                originalName: tool.name,
                namespacedName: namespacedToolName(s.id, tool.name),
                description: tool.description || '',
                inputSchema: sanitizeSchema(tool.inputSchema) || { type: 'object', properties: {} },
            });
        }
    }
    return flat;
}

export function resolveToolCall(namespacedName, mcpTools) {
    const hit = mcpTools.find(t => t.namespacedName === namespacedName);
    if (!hit) return null;
    return { serverId: hit.serverId, serverName: hit.serverName, toolName: hit.originalName };
}

export function toAnthropicTools(mcpTools) {
    return mcpTools.map(t => ({
        name: t.namespacedName,
        description: t.description ? `[${t.serverName}] ${t.description}` : `[${t.serverName}]`,
        input_schema: t.inputSchema,
    }));
}

export function toOpenAiTools(mcpTools) {
    return mcpTools.map(t => ({
        type: 'function',
        function: {
            name: t.namespacedName,
            description: t.description ? `[${t.serverName}] ${t.description}` : `[${t.serverName}]`,
            parameters: t.inputSchema,
        },
    }));
}

// 关键字 gating：与手机端 filterServersByKeywords 一致——没设关键字=永远生效。
export function filterServersByKeywords(servers, text) {
    const t = (text || '').toLowerCase();
    return (servers || []).filter(s => {
        const kws = String(s?.triggerKeywords || '').split(/[,，\s]+/).map(k => k.trim().toLowerCase()).filter(Boolean);
        if (kws.length === 0) return true;
        return kws.some(kw => t.includes(kw));
    });
}
