'use strict';
/* =====================================================================
   character-card.js —— 角色卡（兼容 SillyTavern Character Card V2 / V3）
   ---------------------------------------------------------------------
   · 读：.json（V1 扁平 / V2 chara_card_v2 / V3 chara_card_v3）
         .png（tEXt 块 keyword=chara(V2,base64) 或 ccv3(V3,base64)）
   · 写：.json（V2）与 .png（同时写 chara + ccv3 两个块，酒馆新旧版都认）
   · 卡只装「人设」：白名单字段导出，记忆/聊天记录/世界书/未知扩展一律剥掉，
     保证分享出去的卡不带本机任何对话内容。
   · 组提示词借鉴 SurfCore persona-layers：分层（身份 / 人格 / 场景 / 示例 / 指令）
     + 总预算，超预算先砍示例，再砍场景，人格核心最后才截断并标记。
   纯 Node，无第三方依赖，可单测。
   ===================================================================== */
const zlib = require('zlib');

const PERSONA_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags',
  'creator', 'character_version'];
const MAX_FIELD = 20000;           // 单字段上限（防止有人塞超大卡把提示词撑爆）
const MAX_CARD_BYTES = 8 * 1024 * 1024;

/* ---------------- 归一 ---------------- */
function str(v, max = MAX_FIELD) { return v == null ? '' : String(v).replace(/\r\n/g, '\n').slice(0, max); }

/** 任意来源 → 内部统一结构（只留人设字段） */
function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('不是有效的角色卡 JSON');
  let d = raw;
  if ((raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') && raw.data && typeof raw.data === 'object') d = raw.data;
  else if (raw.data && typeof raw.data === 'object' && raw.data.name) d = raw.data;
  // V1 用 char_name / char_persona 之类的老键名（Pygmalion/TavernAI 早期）
  const card = {
    name: str(d.name || d.char_name, 80).trim(),
    description: str(d.description || d.char_persona),
    personality: str(d.personality),
    scenario: str(d.scenario || d.world_scenario),
    first_mes: str(d.first_mes || d.char_greeting),
    mes_example: str(d.mes_example || d.example_dialogue),
    creator_notes: str(d.creator_notes || d.creatorcomment),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.slice(0, 20).map((x) => str(x)) : [],
    tags: Array.isArray(d.tags) ? d.tags.slice(0, 30).map((x) => str(x, 40)).filter(Boolean) : [],
    creator: str(d.creator, 80),
    character_version: str(d.character_version, 40),
  };
  if (!card.name) throw new Error('角色卡缺少 name（角色名）');
  if (!card.description && !card.personality && !card.system_prompt) throw new Error('角色卡没有任何人设内容（description / personality / system_prompt 都为空）');
  return card;
}

/** 内部结构 → 可分享的 V2 JSON（白名单，不含记忆） */
function toV2(card) {
  const c = normalizeCard(card);
  const data = {};
  for (const k of PERSONA_FIELDS) data[k] = c[k];
  data.extensions = { catwhale: { kind: 'persona-only', exportedBy: 'catwhale-pet' } };
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}
function toV3(card) {
  const v2 = toV2(card);
  return { spec: 'chara_card_v3', spec_version: '3.0', data: Object.assign({}, v2.data, { group_only_greetings: [] }) };
}

/* ---------------- PNG tEXt 读写 ---------------- */
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function readPngChunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件');
  const chunks = [];
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('PNG 已损坏（块越界）');
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 取 PNG 里所有文本块 {keyword: text}（tEXt / zTXt / iTXt 未压缩） */
function pngTextEntries(buf) {
  const out = {};
  for (const ch of readPngChunks(buf)) {
    try {
      if (ch.type === 'tEXt') {
        const i = ch.data.indexOf(0);
        out[ch.data.toString('latin1', 0, i)] = ch.data.toString('latin1', i + 1);
      } else if (ch.type === 'zTXt') {
        const i = ch.data.indexOf(0);
        out[ch.data.toString('latin1', 0, i)] = zlib.inflateSync(ch.data.subarray(i + 2)).toString('latin1');
      } else if (ch.type === 'iTXt') {
        const i = ch.data.indexOf(0);
        const kw = ch.data.toString('latin1', 0, i);
        const compressed = ch.data[i + 1];
        let q = i + 3;
        q = ch.data.indexOf(0, q) + 1;           // language tag
        q = ch.data.indexOf(0, q) + 1;           // translated keyword
        const body = ch.data.subarray(q);
        out[kw] = (compressed ? zlib.inflateSync(body) : body).toString('utf8');
      }
    } catch (e) { /* 坏块跳过 */ }
  }
  return out;
}
function decodeB64Json(s) {
  const txt = Buffer.from(String(s).trim(), 'base64').toString('utf8');
  return JSON.parse(txt);
}

/** 从 PNG 读出角色卡（优先 V3 ccv3，回退 V2 chara） */
function cardFromPng(buf) {
  const t = pngTextEntries(buf);
  const key = Object.keys(t).find((k) => k.toLowerCase() === 'ccv3') || Object.keys(t).find((k) => k.toLowerCase() === 'chara');
  if (!key) throw new Error('这张 PNG 里没有角色卡数据（缺 chara / ccv3 文本块）');
  return normalizeCard(decodeB64Json(t[key]));
}

/** 把角色卡写进一张 PNG（去掉旧的 chara/ccv3 块，在 IEND 前插入新块） */
function cardToPng(card, pngBuf) {
  const chunks = readPngChunks(pngBuf);
  const keep = chunks.filter((ch) => {
    if (ch.type !== 'tEXt' && ch.type !== 'iTXt' && ch.type !== 'zTXt') return true;
    const kw = ch.data.toString('latin1', 0, ch.data.indexOf(0)).toLowerCase();
    return kw !== 'chara' && kw !== 'ccv3';
  });
  const b64v2 = Buffer.from(JSON.stringify(toV2(card)), 'utf8').toString('base64');
  const b64v3 = Buffer.from(JSON.stringify(toV3(card)), 'utf8').toString('base64');
  const extra = [
    pngChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64v2, 'latin1')])),
    pngChunk('tEXt', Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(b64v3, 'latin1')])),
  ];
  const parts = [PNG_SIG];
  for (const ch of keep) {
    if (ch.type === 'IEND') parts.push(...extra);
    parts.push(pngChunk(ch.type, Buffer.from(ch.data)));
  }
  return Buffer.concat(parts);
}

/** 自动判断文件内容：PNG 还是 JSON */
function parseCardFile(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length > MAX_CARD_BYTES) throw new Error('文件过大（>8MB），不像角色卡');
  if (buf.subarray(0, 8).equals(PNG_SIG)) return { card: cardFromPng(buf), format: 'png' };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('既不是 PNG 也不是合法 JSON：' + e.message); }
  return { card: normalizeCard(j), format: 'json' };
}

/* ---------------- 组提示词 ---------------- */
function macros(s, ctx) {
  return String(s || '')
    .replace(/\{\{char\}\}|<BOT>/gi, ctx.char)
    .replace(/\{\{user\}\}|<USER>/gi, ctx.user)
    .replace(/\{\{original\}\}/gi, '');
}

const PET_SCENE = '你现在以桌面宠物的形态住在{{user}}的电脑屏幕上，对方通过桌宠的聊天框和你说话。'
  + '回复像即时聊天：口语、简短（通常 1~3 句），不要用 Markdown 标题和列表，不要替{{user}}说话或描写{{user}}的动作。';

/**
 * 把角色卡组合成 system prompt。
 * @returns {{system, post, greeting, chars, layers, omitted, truncated}}
 */
function composeSystemPrompt(card, opts = {}) {
  const c = normalizeCard(card);
  const ctx = { char: c.name, user: (opts.userName || '用户').trim() || '用户' };
  const budget = Math.max(0, Number(opts.maxChars == null ? 6000 : opts.maxChars) || 0);
  const layers = [
    { id: 'identity', label: '身份', text: c.system_prompt ? macros(c.system_prompt, ctx) : `你将扮演「${c.name}」，始终以 ${c.name} 的身份、口吻和{{user}}对话，不要跳出角色解释自己是 AI 模型或提示词。`.replace('{{user}}', ctx.user), keep: true },
    { id: 'core', label: '人设', text: [c.description, c.personality ? '性格：' + c.personality : ''].filter(Boolean).map((x) => macros(x, ctx)).join('\n\n'), keep: true },
    { id: 'scene', label: '场景', text: [c.scenario ? macros(c.scenario, ctx) : '', opts.petScene === false ? '' : macros(PET_SCENE, ctx)].filter(Boolean).join('\n\n') },
    { id: 'example', label: '对话示例（只示范语气与长度）', text: macros(c.mes_example.replace(/<START>/gi, '———'), ctx) },
  ].filter((l) => l.text && l.text.trim());

  // 超预算顺序：先砍示例 → 再砍场景 → 最后截断人设
  const omitted = [];
  let truncated = false;
  const total = () => layers.reduce((s, l) => s + l.text.length + l.label.length + 4, 0);
  if (budget > 0) {
    for (const id of ['example', 'scene']) {
      if (total() <= budget) break;
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) { omitted.push(id); layers.splice(i, 1); }
    }
    if (total() > budget) {
      const core = layers.find((l) => l.id === 'core');
      if (core) {
        const over = total() - budget;
        core.text = core.text.slice(0, Math.max(200, core.text.length - over)).trimEnd() + '…（人设过长，已截断）';
        truncated = true;
      }
    }
  }
  const system = layers.map((l) => `【${l.label}】\n${l.text.trim()}`).join('\n\n');
  const counts = {};
  for (const l of layers) counts[l.id] = l.text.length;
  return {
    system,
    post: macros(c.post_history_instructions, ctx).trim(),
    greeting: macros(c.first_mes, ctx).trim(),
    chars: system.length, layers: counts, omitted, truncated,
  };
}

/** 组装一次请求的消息列表：system + 最近 N 轮历史 + （可选）历史后指令 + 本轮 */
function buildMessages(card, history, userText, opts = {}) {
  const p = card ? composeSystemPrompt(card, opts) : null;
  const msgs = [];
  if (p && p.system) msgs.push({ role: 'system', content: p.system });
  else if (opts.defaultSystem) msgs.push({ role: 'system', content: opts.defaultSystem });
  const maxTurns = Math.max(0, Number(opts.historyTurns == null ? 12 : opts.historyTurns));
  const hist = (history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-maxTurns * 2);
  for (const m of hist) msgs.push({ role: m.role, content: String(m.text) });
  if (p && p.post) msgs.push({ role: 'system', content: p.post });
  msgs.push({ role: 'user', content: String(userText) });
  return msgs;
}

/** 文件名安全的 id */
function cardId(name) {
  const ascii = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return (ascii || 'char') + '-' + Date.now().toString(36);
}

module.exports = {
  PERSONA_FIELDS, normalizeCard, toV2, toV3, parseCardFile, cardFromPng, cardToPng,
  pngTextEntries, readPngChunks, crc32, composeSystemPrompt, buildMessages, cardId, macros,
};
