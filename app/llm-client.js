'use strict';
/* =====================================================================
   llm-client.js —— 直连大模型 API（不经 harness）
   支持两种协议：
     · openai    : POST {base}/chat/completions   （OpenAI / DeepSeek / 通义 / 本地 llama.cpp 等兼容端）
     · anthropic : POST {base}/v1/messages        （Anthropic 及兼容中转）
   流式 SSE 解析，事件形状与 harness-client 对齐（delta / message / usage / turnEnd），
   这样页面的聊天面板不用分两套渲染。
   纯 Node（全局 fetch，Node ≥18 / Electron 自带），不认识 Electron，可单测。
   ===================================================================== */

const PROTOCOLS = ['openai', 'anthropic'];

/** 规范化 base URL：去尾斜杠；anthropic 允许用户填带不带 /v1 都行 */
function endpointFor(protocol, baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('API 网址为空');
  if (!/^https?:\/\//i.test(b)) throw new Error('API 网址必须以 http:// 或 https:// 开头');
  if (protocol === 'anthropic') {
    if (/\/v1\/messages$/.test(b)) return b;
    if (/\/v1$/.test(b)) return b + '/messages';
    return b + '/v1/messages';
  }
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/** 把通用消息列表 [{role:'system'|'user'|'assistant', content}] 转成各协议请求体 */
function buildRequest(opts) {
  const protocol = PROTOCOLS.includes(opts.protocol) ? opts.protocol : 'openai';
  const msgs = (opts.messages || []).filter((m) => m && m.content != null && String(m.content) !== '');
  const maxTokens = Math.max(16, Math.min(Number(opts.maxTokens) || 2048, 200000));
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  let body;
  if (protocol === 'anthropic') {
    const system = msgs.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n\n');
    // Anthropic 要求 user/assistant 严格交替且以 user 开头：合并相邻同角色
    const conv = [];
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const last = conv[conv.length - 1];
      if (last && last.role === role) last.content += '\n\n' + String(m.content);
      else conv.push({ role, content: String(m.content) });
    }
    if (conv.length && conv[0].role !== 'user') conv.unshift({ role: 'user', content: '（开始）' });
    body = { model: opts.model, max_tokens: maxTokens, stream: true, messages: conv };
    if (system) body.system = system;
    if (opts.temperature != null && opts.temperature !== '') body.temperature = Number(opts.temperature);
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    body = { model: opts.model, stream: true, max_tokens: maxTokens,
             messages: msgs.map((m) => ({ role: m.role, content: String(m.content) })),
             stream_options: { include_usage: true } };
    if (opts.temperature != null && opts.temperature !== '') body.temperature = Number(opts.temperature);
    if (opts.apiKey) headers.authorization = 'Bearer ' + opts.apiKey;
  }
  return { protocol, url: endpointFor(protocol, opts.baseUrl), headers, body };
}

/** SSE 增量解析器：喂文本块，吐出每个 data: 负载（字符串） */
function createSseParser(onData) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) onData(data);
      }
    },
    flush() { if (buf.trim()) { const b = buf; buf = ''; this.push(b + '\n\n'); } },
  };
}

/** 把一条 SSE 负载翻译成统一事件；返回 {text?, usage?, done?, error?} */
function translateChunk(protocol, data) {
  if (data === '[DONE]') return { done: true };
  let j;
  try { j = JSON.parse(data); } catch (e) { return {}; }
  if (j.error) return { error: (j.error && (j.error.message || j.error.type)) || JSON.stringify(j.error) };
  if (protocol === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') return { text: j.delta.text || '' };
    if (j.type === 'message_delta' && j.usage) return { usage: { outputTokens: j.usage.output_tokens } };
    if (j.type === 'message_start' && j.message && j.message.usage) return { usage: { inputTokens: j.message.usage.input_tokens } };
    if (j.type === 'message_stop') return { done: true };
    return {};
  }
  const out = {};
  const ch = j.choices && j.choices[0];
  if (ch && ch.delta && typeof ch.delta.content === 'string') out.text = ch.delta.content;
  if (ch && ch.delta && typeof ch.delta.reasoning_content === 'string') out.reasoning = ch.delta.reasoning_content;
  if (j.usage) out.usage = { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
  return out;
}

/**
 * 发一轮对话（流式）。
 * @returns {{promise: Promise<{ok, text, error?, usage, ms}>, abort: Function}}
 */
function streamChat(opts, onEvent = () => {}) {
  const ac = new AbortController();
  const t0 = Date.now();
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const promise = (async () => {
    let text = '', usage = {}, err = '';
    try {
      const req = buildRequest(opts);
      onEvent({ kind: 'route', provider: req.protocol, model: opts.model });
      const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ac.signal });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 400); } catch (e) {}
        throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
      }
      const parser = createSseParser((data) => {
        const r = translateChunk(req.protocol, data);
        if (r.error) err = r.error;
        if (r.text) { text += r.text; onEvent({ kind: 'delta', text: r.text }); }
        if (r.reasoning) onEvent({ kind: 'reasoning', text: r.reasoning });
        if (r.usage) { usage = Object.assign(usage, r.usage); onEvent({ kind: 'usage', usage }); }
      });
      const ct = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '');
      if (!/event-stream/i.test(ct) && res.json) {
        // 有的兼容端忽略 stream:true，直接回整包 JSON
        const j = await res.json();
        if (req.protocol === 'anthropic') text = ((j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
        else text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        if (text) onEvent({ kind: 'delta', text });
      } else {
        const dec = new TextDecoder('utf-8');
        for await (const chunk of res.body) parser.push(typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }));
        parser.flush();
      }
      if (err) throw new Error(err);
      if (!text) throw new Error('模型返回为空');
      onEvent({ kind: 'message', text, usage });
      onEvent({ kind: 'turnEnd', reason: { kind: 'completed' } });
      return { ok: true, text, usage, ms: Date.now() - t0 };
    } catch (e) {
      const aborted = ac.signal.aborted;
      const msg = aborted ? ((ac.signal.reason && ac.signal.reason.message) || '已取消') : ((e && e.message) || String(e));
      onEvent({ kind: 'turnEnd', reason: { kind: aborted && msg === '已取消' ? 'cancelled' : 'error', error: { message: msg } } });
      return { ok: false, text, error: msg, usage, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  })();
  return { promise, abort: () => ac.abort(new Error('已取消')) };
}

module.exports = { PROTOCOLS, endpointFor, buildRequest, createSseParser, translateChunk, streamChat };
