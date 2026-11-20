/* 聊天里的走动指令解析（纯函数，浏览器与 Node 共用）
 *
 * 设计原则：**宁可漏判，绝不能误判**。
 * 桌宠的聊天是日常对话入口，把「左边那个按钮是什么」当成指令会让聊天直接坏掉，
 * 所以这里要求整句话就是一个明确指令（可以带礼貌前缀与标点），
 * 而且必须同时满足：有方向词 + 有动作词或像素数。
 * 普通句子、问句、把指令当引用的句子一律返回 null → 交给原聊天后端。
 *
 * 只有「用户这次输入」会走这里：AI 回复文本、历史记录重放都不解析（调用点在 sendChat 一处）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatwhaleWalkCommand = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_DISTANCE = 40;          // 少于 40 像素看不出动过，按 40 执行
  const MAX_DISTANCE = 4000;        // 一次最多走 4000 像素（再远就分几次说）
  const DEFAULT_DISTANCE = 240;     // 没说距离时的默认步长

  const PAD = '[\\s,，]*';
  const PREFIX = '(?:(?:请|请你|帮我|帮忙|给我|麻烦你?|小鲸|猫鲸|宝宝)' + PAD + ')*';
  const DIRS = { 左: 'left', 左边: 'left', 左面: 'left', 右: 'right', 右边: 'right', 右面: 'right',
                 上: 'up', 上面: 'up', 上边: 'up', 下: 'down', 下面: 'down', 下边: 'down' };
  const STOP_RE = /^(?:停|停下|停一下|停一停|停下来|停住|站住|别走|别走了|不要走|不要走了|不许走|不走了|停止|停止走动)[\s!.~～]*$/;
  const WALK_RE = new RegExp(
    '^' + PREFIX +
    '(?:向|往|朝)?' + PAD +
    '(左边|左面|右边|右面|上边|上面|下边|下面|左|右|上|下)' + PAD +
    '((?:走一走|走走|走|移动|挪|去|跑)' + PAD + ')?' +
    '((?:[0-9]+(?:\\.[0-9]+)?)\\s*(?:个)?\\s*(?:像素|px|步)?' + PAD + ')?' +
    '(?:吧|呀|啊|呗|嘛|好不好|行吗)?' + PAD +
    '[!.~～]*$'
  );

  /** 全角数字/字母/标点 → 半角，全角空格 → 空格（中文输入法下极常见） */
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .replace(/[\u3001\u3002]/g, (c) => (c === '\u3002' ? '.' : ','))
      .trim();
  }

  /**
   * @returns {null | {type:'stop'} | {type:'walk', dx:-1|0|1, dy:-1|0|1, distance:number|null, dir:string}}
   *   distance=null 表示用户没说距离（由调用方用默认步长）。
   */
  function parse(text) {
    const s = normalize(text);
    if (!s) return null;
    if (STOP_RE.test(s)) return { type: 'stop' };

    const m = WALK_RE.exec(s);
    if (!m) return null;
    const dirWord = m[1], verb = m[2], distRaw = m[3];
    if (!verb && !distRaw) return null;          // 「往右」「右边」这种不算指令，避免劫持聊天
    // 有单位却没数字（例如「向左走 像素」）说明写错了：整句不认
    if (distRaw && !/[0-9]/.test(distRaw)) return null;
    const dir = DIRS[dirWord];
    if (!dir) return null;

    let distance = null;
    if (distRaw) {
      const v = Number(String(distRaw).replace(/[^0-9.]/g, ''));
      if (isFinite(v)) distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, Math.round(v)));
    }
    const vec = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    return { type: 'walk', dx: vec[0], dy: vec[1], distance, dir };
  }

  const DIR_CN = { left: '左', right: '右', up: '上', down: '下' };

  /** 生成给用户看的中文反馈。result={moved,clamped} 由执行方按实际位移填。 */
  function describe(cmd, result) {
    if (!cmd || cmd.type === 'stop') return '好，停下了。';
    const name = DIR_CN[cmd.dir] || '那边';
    const moved = result && isFinite(result.moved) ? Math.round(result.moved) : null;
    if (result && result.clamped && moved !== null) {
      return '到边上了——按当前走动范围只往' + name + '走了 ' + moved + ' 像素。';
    }
    if (moved !== null) return '好，往' + name + '走了 ' + moved + ' 像素。';
    return '好，往' + name + '走。';
  }

  return { MIN_DISTANCE, MAX_DISTANCE, DEFAULT_DISTANCE, normalize, parse, describe };
});
