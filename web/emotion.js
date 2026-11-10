/* 猫鲸桌宠 · 情绪识别（人格化表情差分用）
 *
 * 把一段对话文本映射到 8 种表情动作之一：
 *   happy 开心 / shy 害羞 / angry 生气 / sad 难过 / surprised 惊讶 / think 思考 / proud 得意 / wave 打招呼
 * 识别不到就返回 null（保持原状态，不硬演）。
 *
 * 规则（按权重累加，取最高分；平分时取在文本里最早出现的那个）：
 *   · 角色扮演里的动作描写（*开心地摇尾巴* / （脸红）/ 【害羞】）权重 3 —— 这是角色自己声明的情绪，最可信
 *   · emoji / 颜文字 权重 2
 *   · 普通词 权重 1
 * 否定前缀（不/没/别/不要）紧贴在词前时，该次命中作废：「不难过」不该演难过。
 *
 * 纯函数、无 DOM：web/index.html 用 window.CatwhaleEmotion，Node 测试用 require()。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatwhaleEmotion = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMOTIONS = ['happy', 'shy', 'angry', 'sad', 'surprised', 'think', 'proud', 'wave'];
  const LABEL = { happy: '开心', shy: '害羞', angry: '生气', sad: '难过', surprised: '惊讶', think: '思考', proud: '得意', wave: '打招呼' };

  // 普通词（权重 1）
  const WORDS = {
    happy: ['开心', '高兴', '好耶', '太好了', '哈哈', '嘿嘿', '嘻嘻', '真棒', '好棒', '耶', '快乐', '喜欢', '幸福', '乐意', '没问题哦', '太棒'],
    shy: ['害羞', '脸红', '不好意思', '讨厌啦', '人家', '羞', '难为情', '才、才不', '才不是', '别这样说', '被夸'],
    angry: ['生气', '气死', '可恶', '不理你', '哼！', '哼!', '讨厌', '过分', '烦死', '别闹', '恼'],
    sad: ['难过', '伤心', '呜呜', '哭', '委屈', '对不起', '抱歉', '遗憾', '失落', '心疼', '可惜', '唉'],
    surprised: ['诶', '欸', '哇', '居然', '竟然', '真的吗', '天哪', '天呐', '吓', '没想到', '什么？', '什么?', '咦'],
    think: ['让我想想', '想想', '思考', '琢磨', '嗯……', '嗯...', '唔', '也许', '大概', '或许', '我猜', '考虑', '好问题'],
    proud: ['交给我', '小菜一碟', '厉害吧', '不愧是我', '本小姐', '那当然', '当然啦', '哼哼', '得意', '骄傲', '轻松搞定'],
    wave: ['你好', '早上好', '早安', '中午好', '下午好', '晚上好', '嗨', '哈喽', '欢迎', '回来啦', '回来了', '拜拜', '再见', '晚安', '好久不见', '见到你'],
  };
  // emoji / 颜文字（权重 2）
  const MARKS = {
    happy: ['😄', '😆', '😊', '😁', '🥰', '🎉', '😃', '☺', '(≧▽≦)', '(^▽^)', '^_^', '^^', 'ヾ(≧▽≦*)', '(*^▽^*)'],
    shy: ['😳', '☺️', '🙈', '(*/ω＼*)', '(/ω＼)', '///', '(〃ω〃)', '>///<'],
    angry: ['😠', '😤', '😡', '💢', '(╬', '(｀へ´)', '(`へ´)'],
    sad: ['😢', '😭', '🥺', '😞', '😔', '💔', 'QAQ', 'QwQ', 'T_T', 'TAT', '(；ω；)'],
    surprised: ['😮', '😲', '😯', '😱', '❗', '⁉', '!?', '！？', '?!', '？！', 'Σ(', '(⊙o⊙)', 'O_O', '(°ロ°)'],
    think: ['🤔', '💭', '(￢_￢)', '(・_・;'],
    proud: ['😎', '💪', '✌', '(￣▽￣)', '( •̀ ω •́ )', 'ドヤ'],
    wave: ['👋', '🙋', 'ヾ(•ω•`)o', '(・ω・)ノ', '( ´ ▽ ` )ﾉ'],
  };
  const NEG = ['不', '没', '别', '不要', '没有', '不会'];

  // 动作描写：*...* / （...）/ (...) / 【...】，长度 ≤ 20 才算（避免把一整句括号说明当动作）
  const ACTION_RE = /\*([^*\n]{1,20})\*|（([^（）\n]{1,20})）|\(([^()\n]{1,20})\)|【([^【】\n]{1,20})】/g;

  function negated(text, idx) {
    for (const n of NEG) {
      if (idx >= n.length && text.slice(idx - n.length, idx) === n) return true;
    }
    return false;
  }

  function scoreInto(text, table, weight, score, first, base) {
    for (const emo of EMOTIONS) {
      for (const w of table[emo]) {
        let i = text.indexOf(w);
        while (i >= 0) {
          if (!negated(text, i)) {
            score[emo] += weight;
            const pos = base + i;
            if (first[emo] < 0 || pos < first[emo]) first[emo] = pos;
          }
          i = text.indexOf(w, i + w.length);
        }
      }
    }
  }

  /** @returns {{emotion: string|null, score: object, label: string}} */
  function analyze(text) {
    const s = String(text || '');
    const score = {}, first = {};
    for (const e of EMOTIONS) { score[e] = 0; first[e] = -1; }
    if (!s.trim()) return { emotion: null, score, label: '' };
    // 代码块里的字不算情绪（「抱歉」写在 commit message 里不该演难过）
    const plain = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

    let m;
    ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(plain))) {
      const inner = m[1] || m[2] || m[3] || m[4] || '';
      scoreInto(inner, WORDS, 3, score, first, m.index);
    }
    scoreInto(plain, WORDS, 1, score, first, 0);
    scoreInto(plain, MARKS, 2, score, first, 0);

    let best = null;
    for (const e of EMOTIONS) {
      if (score[e] <= 0) continue;
      if (!best || score[e] > score[best] || (score[e] === score[best] && first[e] < first[best])) best = e;
    }
    return { emotion: best, score, label: best ? LABEL[best] : '' };
  }

  function detect(text) { return analyze(text).emotion; }

  return { EMOTIONS, LABEL, WORDS, MARKS, analyze, detect };
});
