'use strict';
/* =============================================================================
 * 验证码抽取（纯规则，零依赖）
 * -----------------------------------------------------------------------------
 * 目标：从「主题 + 正文」里挑出那一串 4~8 位数字，并给出上下文，供面板展示
 * 和用户核对。难点不是找数字，而是别把手机号 / 金额 / 日期 / 订单号当成验证码。
 *
 * 策略（按优先级）：
 *   1. 硬关键词（验证码/校验码/动态码/verification code/OTP…）60 字内出现的
 *      4~8 位数字，距离越近分越高；关键词在数字前面（"验证码是 123456"）再加分。
 *   2. 硬关键词紧邻时，跳过「弱排除词」判断（"您的账号验证码为 123456" 不能
 *      因为看到"账号"就被毙掉）。
 *   3. 没有关键词时只在「主题」或「短正文（<160 字）」里兜底取一个数字，
 *      长邮件里没有关键词就判定为没有验证码，宁可不弹也不误弹。
 *
 * 排除项：
 *   - 11 位手机号：候选最长 8 位 + 前后数字边界，天然进不来；再有关键词豁免。
 *   - 金额：后面跟 元/块/美元/USD/CNY/RMB/%/折，前面有 ¥/￥/$ 或金额类用词。
 *   - 日期：2026-11-25、2026年11月25日、纯年份 19xx/20xx（无关键词时）。
 *   - 订单/单号/运单/发票/邮编/流水号：紧邻这些词的数字直接丢弃。
 *   - 账号/卡号/手机/QQ 号：6 位以上且没有硬关键词时丢弃。
 * ============================================================================= */

/** 强关键词：命中即高置信。英文一律按小写匹配。 */
const STRONG_KEYWORDS = [
  '验证码', '校验码', '动态码', '动态密码', '验证代码', '确认码', '安全码',
  '激活码', '提取码', '短信验证码', '登录码', '临时密码',
  'verification code', 'verify code', 'security code', 'confirmation code',
  'one-time password', 'one time password', 'one-time code', 'one time code',
  'authentication code', 'auth code', 'login code', 'access code',
  'passcode', 'otp'
];

/** 弱关键词：只在没有强关键词时才用，分值低。 */
const SOFT_KEYWORDS = ['code', 'pin', '验证'];

/** 数字前面出现这些词 → 直接丢（单号/金额类，几乎不可能是验证码）。 */
const REJECT_BEFORE_STRONG = /(订单号?|单号|运单|快递|物流|发票|编号|序号|流水号|邮编|zip|金额|合计|总计|小计|余额|价格|单价|货款|amount|total|price|invoice|tracking|order\s*(no|id|number)?\s*[:#]?\s*)/i;

/** 数字前面出现这些词 → 仅在没有硬关键词时丢（账号/号码类）。 */
const REJECT_BEFORE_WEAK = /(账号|帐号|账户|卡号|手机|电话|座机|tel|phone|mobile|fax|qq|微信|身份证|证件号|学号|工号|编号)/i;

/** 数字后面跟这些 → 是数量/金额，不是验证码。 */
const REJECT_AFTER = /^\s*(元|块|万元|亿美元?|美元|港币|人民币|usd|cny|rmb|%|折|个|件|次|人|名|张|台|套|公斤|kg|克|g\b|米|m\b|积分|点)/i;

/** 金额前缀：¥ ￥ $ 之类紧贴的数字。 */
const REJECT_BEFORE_MONEY = /[¥￥$]\s*$/;

/** 候选：4~8 位数字，允许中间夹单个空格或短横（123-456 / 123 456）。 */
const CANDIDATE_RE = /(?<![\dA-Za-z])(\d(?:[ \-]?\d){3,7})(?![\dA-Za-z])/g;

const MAX_CONTEXT = 120;

/** 全角数字转半角、全角空格转空格、统一换行。 */
function normalizeText(input) {
  return String(input == null ? '' : input)
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\r\n?/g, '\n');
}

/** 关键词到候选的距离（字符数）；before=true 表示关键词整体在候选前面。 */
function nearestKeyword(text, keywords, idx, len) {
  const hay = text.toLowerCase();
  let best = null;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let from = 0;
    for (;;) {
      const p = hay.indexOf(k, from);
      if (p < 0) break;
      const cw = k.length > 4 ? 6 : k.length;   // 中文词按字算，英文按词长近似
      let dist;
      if (p + cw <= idx) dist = idx - (p + cw);
      else if (p >= idx + len) dist = p - (idx + len);
      else dist = 0;                            // 重叠（极少）
      if (best === null || dist < best.dist) {
        best = { dist, kw, before: p + cw <= idx + 1 };
      }
      from = p + 1;
    }
  }
  return best;
}

/** 像日期/时间吗？ */
function looksLikeDate(text, idx, len) {
  const around = text.slice(Math.max(0, idx - 14), idx + len + 14);
  // 2026-11-25 / 2026.11.25 / 2026/11/25 / 2026年11月25日
  if (/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/.test(around)) return true;
  const before = text.slice(Math.max(0, idx - 2), idx);
  const after = text.slice(idx + len, idx + len + 3).replace(/^[ \t]+/, '');
  if (/[年月日时点]/.test(before)) return true;
  if (/^[年月日时点]/.test(after)) return true;
  return false;
}

function contextAround(text, idx, len) {
  const start = Math.max(0, idx - 45);
  const end = Math.min(text.length, idx + len + 45);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s.length > MAX_CONTEXT ? s.slice(0, MAX_CONTEXT) + '…' : s;
}

/**
 * 在单段文本里收集候选。
 * @param {string} text 已归一化的文本
 * @param {'subject'|'body'} where
 */
function collect(text, where) {
  const out = [];
  if (!text) return out;
  CANDIDATE_RE.lastIndex = 0;

  // 用 exec 循环而不是 matchAll，方便按 lastIndex 拿到准确位置
  let m;
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    const raw = m[1];
    const code = raw.replace(/[\s\-]/g, '');
    const digits = code.length;
    const idx = m.index;
    if (digits < 4 || digits > 8) continue;
    if (digits === 11) continue;                       // 手机号

    const before = text.slice(Math.max(0, idx - 20), idx);
    const after = text.slice(idx + raw.length, idx + raw.length + 10);
    const near = nearestKeyword(text, STRONG_KEYWORDS, idx, raw.length);
    const strong = near && near.dist <= 20;

    if (REJECT_BEFORE_MONEY.test(before)) continue;
    if (!strong) {
      if (REJECT_BEFORE_STRONG.test(before.slice(-14))) continue;
      if (digits >= 6 && REJECT_BEFORE_WEAK.test(before.slice(-14))) continue;
      if (REJECT_AFTER.test(after)) continue;
    } else if (near && REJECT_AFTER.test(after) && near.dist > 8) {
      continue;
    }
    if (looksLikeDate(text, idx, raw.length)) continue;
    if (digits === 4 && /^(19|20)\d{2}$/.test(code) && !near) continue;   // 裸年份

    // 打分
    let score = 0;
    if (near && near.dist <= 60) {
      score = 120 - Math.min(near.dist, 60);
      if (near.before) score += 15;                    // "验证码是 123456"
    } else {
      const soft = nearestKeyword(text, SOFT_KEYWORDS, idx, raw.length);
      if (soft && soft.dist <= 40) score = 40 - soft.dist;
    }
    // 兜底：主题里、或很短的正文里出现的数字
    if (score === 0) {
      if (where === 'subject') score = 30;
      else if (text.length < 160) score = 25;
      else continue;
    }
    // 4 位数字天然更可疑（年份/数量多），压一档
    if (digits === 4) score -= 5;

    out.push({
      code,
      raw,
      index: idx,
      where,
      score,
      context: contextAround(text, idx, raw.length)
    });
  }
  return out;
}

/**
 * 抽验证码。
 * @param {string|{subject?:string, text?:string, body?:string}} input
 * @returns {{code:string|null, context:string|null, where?:string}}
 */
function extractCode(input) {
  let subject = '';
  let body = '';
  if (typeof input === 'string') {
    body = normalizeText(input);
  } else if (input && typeof input === 'object') {
    subject = normalizeText(input.subject || '');
    body = normalizeText(input.text || input.body || '');
  }

  const cands = collect(subject, 'subject').concat(collect(body, 'body'));
  if (!cands.length) return { code: null, context: null };

  // 分值优先；同分时主题优先、再按出现顺序
  cands.sort((a, b) => (b.score - a.score)
    || (a.where === 'subject' ? -1 : 1)
    || (a.index - b.index));

  const best = cands[0];
  return { code: best.code, context: best.context, where: best.where };
}

module.exports = {
  extractCode,
  normalizeText,
  STRONG_KEYWORDS,
  SOFT_KEYWORDS
};
