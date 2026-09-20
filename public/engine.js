/*
 * 字幕时间轴约束引擎（浏览器 / Node 共用）
 *
 * 不变式（任何时刻都必须成立）：
 *   1. 每条字幕时长 >= MIN_DURATION_MS（500ms）
 *   2. 相邻字幕间隔 >= MIN_GAP_MS（100ms）
 *   3. 起点 >= 0
 *
 * 拖动规则：
 *   - 拖动右边界越过“后继安全线”（next.start - MIN_GAP）时，
 *     超出量递归推移所有受影响的后继块，且保持各块时长不变；
 *   - 向回拖动只释放空隙，不自动拉回后继块；
 *   - 拖动左边界时不推移前驱块，仅在 0 / 前驱安全线 / 最短时长处夹取；
 *   - 按住块主体整块平移时保持时长不变：向左在 0 / 前驱安全线处夹取，
 *     向右越过后继安全线时同样递归推移后继块；同一次手势内先推后回拖，
 *     已被推开的后继不自动回拉。
 *
 * 区间变速：
 *   - 以入点为锚点，把 [入点, 出点] 线性映射到目标时长；
 *   - 区间内及跨越边界的字幕参与映射，区间外字幕保持不动；
 *   - 映射后在受影响字幕内部自动补足最短时长、后移间隔不足的后继；
 *   - 若约束只能依靠改动区间外字幕才能满足，则不静默改写，
 *     返回可定位的冲突列表。
 *
 * 帧对齐：
 *   - 把全部字幕的起止点吸附到指定帧率（23.976/24/25/29.97/30）的帧边界；
 *   - 在「单点最大允许偏移」容差内做全局动态规划：冲突时联动选择相邻帧，
 *     使所有点的总绝对偏移最小；总分相同取整体较早（逐帧下标字典序更小）方案；
 *   - 始终保持每块 >= 500ms、相邻间隔 >= 100ms、起点 >= 0 与原顺序；
 *   - 任一点超出容差或无可行方案时返回可定位冲突，不修改任何字幕。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MIN_DURATION_MS = 500;
  const MIN_GAP_MS = 100;

  function pad(n, w) { return String(n).padStart(w, '0'); }

  /** 毫秒 -> SRT 时间码 HH:MM:SS,mmm */
  function msToTimecode(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(r, 3);
  }

  /** SRT 时间码 -> 毫秒；非法返回 null。兼容逗号/句点分隔。 */
  function timecodeToMs(tc) {
    const m = String(tc).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
    if (!m) return null;
    return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4].padEnd(3, '0'));
  }

  /**
   * 宽松时间输入解析 -> 毫秒；非法返回 null。
   * 支持：纯秒数（如 "3.5"）、MM:SS[,mmm]、HH:MM:SS[,mmm]，毫秒兼容逗号/句点。
   */
  function parseTimeInput(str) {
    const s = String(str == null ? '' : str).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000); // 纯秒数
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
    if (!m) return null;
    return (m[1] ? +m[1] : 0) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 +
           (m[4] ? +m[4].padEnd(3, '0') : 0);
  }

  /** 解析 SRT 文本 -> [{start, end, text}]（未做约束修正） */
  function parseSrt(text) {
    const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    for (const raw of src.split(/\n[ \t]*\n/)) {
      const lines = raw.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
      if (!lines.length) continue;
      let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0; // 序号行可有可无
      const tcLine = lines[i];
      if (!tcLine || tcLine.indexOf('-->') === -1) continue;
      const parts = tcLine.split('-->');
      const start = timecodeToMs(parts[0]);
      // 结束时间码后可能跟坐标等设置，只取第一个 token
      const end = timecodeToMs((parts[1] || '').trim().split(/\s+/)[0]);
      if (start == null || end == null) continue;
      cues.push({ start, end, text: lines.slice(i + 1).join('\n') });
    }
    return cues;
  }

  /** 序列化为合法 SRT（序号重排、逗号分隔） */
  function formatSrt(cues) {
    return cues.map((c, i) =>
      (i + 1) + '\n' + msToTimecode(c.start) + ' --> ' + msToTimecode(c.end) + '\n' + c.text
    ).join('\n\n') + '\n';
  }

  /**
   * 导入时规整：排序、负起点归零、补足最短时长、
   * 间隔不足时把后继块整体后移（保持时长），保证初始状态合法。
   */
  function normalize(cues) {
    cues.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let minStart = 0;
    for (const c of cues) {
      if (c.start < minStart) {
        const shift = minStart - c.start; // 整体平移，时长不变
        c.start += shift;
        c.end += shift;
      }
      if (c.end < c.start + MIN_DURATION_MS) c.end = c.start + MIN_DURATION_MS;
      minStart = c.end + MIN_GAP_MS;
    }
    return cues;
  }

  /** 从 index 起向后检查：间隔不足的后继块整体后移（保持时长），空隙足够即停止 */
  function pushSuccessors(cues, index) {
    let prev = cues[index];
    for (let k = index + 1; k < cues.length; k++) {
      const cur = cues[k];
      const minStart = prev.end + MIN_GAP_MS;
      if (cur.start >= minStart) break; // 空隙足够，连锁停止
      cur.end += minStart - cur.start;  // 整体平移，时长不变
      cur.start = minStart;
      prev = cur;
    }
  }

  /**
   * 应用一次边界拖动（拖动过程中可反复调用）。
   * @param cues  字幕数组（就地修改）
   * @param index 被拖动的块下标
   * @param edge  'start' | 'end'
   * @param t     期望的边界时间（ms）
   */
  function applyDrag(cues, index, edge, t) {
    const cue = cues[index];
    if (!cue) return cues;
    t = Math.round(t);

    if (edge === 'end') {
      // 最短时长夹取；向回拖动只释放空隙
      cue.end = Math.max(t, cue.start + MIN_DURATION_MS);
      // 越过后继安全线：超出量递归推移后继块，保持各块时长
      pushSuccessors(cues, index);
    } else if (edge === 'start') {
      let s = Math.min(t, cue.end - MIN_DURATION_MS); // 最短时长
      if (s < 0) s = 0;                                // 起点不为负
      if (index > 0) {
        const limit = cues[index - 1].end + MIN_GAP_MS; // 前驱安全线
        if (s < limit) s = limit;
      }
      cue.start = s;
    }
    return cues;
  }

  /**
   * 应用一次整块平移（按住块主体横向拖动，拖动过程中可反复调用）。
   * 时长保持不变；向左在 0 / 前驱安全线处夹取；
   * 向右越过后继安全线时递归推移后继块；回拖只释放空隙，不拉回后继。
   * @param cues  字幕数组（就地修改）
   * @param index 被平移的块下标
   * @param t     期望的起点时间（ms）
   */
  function applyMove(cues, index, t) {
    const cue = cues[index];
    if (!cue) return cues;
    const dur = cue.end - cue.start;
    let s = Math.round(t);
    if (s < 0) s = 0;                                 // 起点不为负
    if (index > 0) {
      const limit = cues[index - 1].end + MIN_GAP_MS; // 前驱安全线
      if (s < limit) s = limit;
    }
    cue.start = s;
    cue.end = s + dur;                                // 整体平移，时长不变
    pushSuccessors(cues, index);
    return cues;
  }

  /**
   * 规划区间变速（纯函数，不修改 cues）。
   * 以入点为锚点，把 [inMs, outMs] 线性映射到目标时长 targetMs；
   * 区间内及跨越边界的字幕参与映射，区间外字幕保持不动。
   * 映射后在受影响字幕内部自动补足最短时长、后移间隔不足的后继；
   * 若只能依靠改动区间外字幕才能满足约束，则不静默改写，返回可定位的冲突。
   *
   * @returns 成功 { ok: true, scale, inMs, outMs, targetMs, newOutMs, affected, changes }
   *          失败 { ok: false, reason } 或 { ok: false, conflicts: [{index, message}] }
   *          （changes/conflicts 中的 index 均为字幕下标，可直接定位）
   */
  function planRetime(cues, inMs, outMs, targetMs) {
    inMs = Math.round(inMs); outMs = Math.round(outMs); targetMs = Math.round(targetMs);
    if (!(inMs >= 0)) return { ok: false, reason: '入点不能为负' };
    if (!(outMs > inMs)) return { ok: false, reason: '出点必须大于入点' };
    if (!(targetMs > 0)) return { ok: false, reason: '目标时长必须大于 0' };

    const scale = targetMs / (outMs - inMs);
    // 锚点线性映射：入点不动，区间端点（含出点）按比例缩放，区间外时间点不动
    const mapT = (t) => (t < inMs || t > outMs) ? t : inMs + (t - inMs) * scale;

    // 受影响字幕：与区间相交（含跨越边界的）
    const affected = [];
    cues.forEach((c, i) => { if (c.start < outMs && c.end > inMs) affected.push(i); });
    if (!affected.length) return { ok: false, reason: '区间内没有字幕' };

    const mapped = cues.map(c => ({ start: c.start, end: c.end }));
    for (const i of affected) {
      mapped[i].start = Math.round(mapT(cues[i].start));
      mapped[i].end = Math.round(mapT(cues[i].end));
    }

    // 跨越出点的字幕：区间外终点被新区间吞没属于冲突（不静默改写区间外时间）
    for (const i of affected) {
      if (cues[i].end > outMs && mapped[i].start >= mapped[i].end) {
        return {
          ok: false,
          conflicts: [{
            index: i,
            message: '第 ' + (i + 1) + ' 条终点在区间外（' + msToTimecode(cues[i].end) +
              '），变速后其映射起点 ' + msToTimecode(mapped[i].start) +
              ' 越过该终点，请减小目标时长或调整出点',
          }],
        };
      }
    }

    // 自动修正（仅受影响字幕）：补足最短时长
    for (const i of affected) {
      const m = mapped[i];
      if (m.end < m.start + MIN_DURATION_MS) m.end = m.start + MIN_DURATION_MS;
    }
    // 自动修正（仅受影响字幕）：间隔不足时后移后继（保持时长）
    for (let k = 1; k < affected.length; k++) {
      const prev = mapped[affected[k - 1]];
      const cur = mapped[affected[k]];
      const minStart = prev.end + MIN_GAP_MS;
      if (cur.start < minStart) {
        cur.end += minStart - cur.start;
        cur.start = minStart;
      }
    }

    // 冲突检测：受影响链与区间外邻居的间隔，不静默改写区间外字幕
    const conflicts = [];
    const first = affected[0];
    const last = affected[affected.length - 1];
    if (first > 0) {
      const gap = mapped[first].start - mapped[first - 1].end;
      if (gap < MIN_GAP_MS) {
        conflicts.push({
          index: first,
          message: '第 ' + (first + 1) + ' 条变速后起点 ' + msToTimecode(mapped[first].start) +
            '，与第 ' + first + ' 条（区间外，终点 ' + msToTimecode(mapped[first - 1].end) +
            '）间隔不足 ' + MIN_GAP_MS + 'ms',
        });
      }
    }
    if (last < cues.length - 1) {
      const gap = mapped[last + 1].start - mapped[last].end;
      if (gap < MIN_GAP_MS) {
        conflicts.push({
          index: last + 1,
          message: '第 ' + (last + 2) + ' 条（区间外，起点 ' + msToTimecode(mapped[last + 1].start) +
            '）与变速后第 ' + (last + 1) + ' 条（终点 ' + msToTimecode(mapped[last].end) +
            '）间隔不足 ' + MIN_GAP_MS + 'ms',
        });
      }
    }
    if (conflicts.length) return { ok: false, conflicts, scale, affected };

    return {
      ok: true,
      scale,
      inMs,
      outMs,
      targetMs,
      newOutMs: inMs + targetMs, // 映射后的出点位置
      affected,
      changes: affected.map(i => ({ index: i, start: mapped[i].start, end: mapped[i].end })),
    };
  }

  /** 应用变速方案：仅改写方案中列出的受影响字幕，区间外字幕不动 */
  function applyPlan(cues, plan) {
    if (!plan || !plan.ok) return cues;
    for (const ch of plan.changes) {
      const c = cues[ch.index];
      if (c) { c.start = ch.start; c.end = ch.end; }
    }
    return cues;
  }

  /* ---------------- 帧对齐 ---------------- */

  /** 可选帧率（fps）与帧周期（ms）。23.976/29.97 按 NTSC 丢帧前精确比率。 */
  const FRAME_RATES = [
    { label: '23.976', fps: 24000 / 1001, frameMs: 1001 * 1000 / 24000 },
    { label: '24', fps: 24, frameMs: 1000 / 24 },
    { label: '25', fps: 25, frameMs: 40 },
    { label: '29.97', fps: 30000 / 1001, frameMs: 1001 * 1000 / 30000 },
    { label: '30', fps: 30, frameMs: 1000 / 30 },
  ];

  /** 按帧率标签取帧周期（ms）；未知标签返回 null */
  function framePeriodMs(fpsLabel) {
    const f = FRAME_RATES.find(x => x.label === String(fpsLabel));
    return f ? f.frameMs : null;
  }

  /** 帧下标 n 对应的帧边界时间（ms，四舍五入到 SRT 的 1ms 精度） */
  function frameEdgeMs(n, frameMs) {
    const e = Math.round(n * frameMs);
    return Object.is(e, -0) ? 0 : e; // n=-0 时避免产生 -0
  }

  /**
   * 规划帧对齐（纯函数，不修改 cues）。
   *
   * 把每条字幕的起止点（共 2N 个，按时序串成 s0<=e0<=s1<=e1...）吸附到
   * frameMs 的整数倍帧边界；每个点只能落在距原值不超过 toleranceMs 的帧上。
   * 约束：起点对应帧下标 >= 0；同块 end-start >= 500ms；相邻块 start-prevEnd >= 100ms。
   * 目标：所有点绝对偏移之和最小；同分取整体较早方案（帧下标向量字典序最小）。
   * 冲突时点与点联动选择相邻帧（动态规划全局求解，而非各自就近贪心）。
   *
   * @param cues
   * @param fpsLabel    '23.976' | '24' | '25' | '29.97' | '30'
   * @param toleranceMs 单点最大允许偏移（非负整数 ms）
   * @returns 成功 { ok:true, fpsLabel, frameMs, toleranceMs, totalDeltaMs,
   *                 maxDeltaMs, changes:[{index,start,end,startDelta,endDelta}] }
   *          失败 { ok:false, reason } 或 { ok:false, conflicts:[{index,message}] }
   */
  function planFrameAlign(cues, fpsLabel, toleranceMs) {
    const frameMs = framePeriodMs(fpsLabel);
    if (frameMs == null) {
      return { ok: false, reason: '不支持的帧率：' + fpsLabel + '（可选 23.976 / 24 / 25 / 29.97 / 30）' };
    }
    toleranceMs = Number(toleranceMs);
    if (!Number.isInteger(toleranceMs) || toleranceMs < 0) {
      return { ok: false, reason: '单点最大允许偏移必须是不小于 0 的整数毫秒' };
    }
    if (!cues.length) return { ok: false, reason: '当前没有字幕' };

    const n = cues.length;
    // 点序列：偶数位 p=2i 为第 i 块起点，奇数位 p=2i+1 为终点
    const points = [];
    for (let i = 0; i < n; i++) {
      points.push({ cue: i, edge: 'start', t: cues[i].start });
      points.push({ cue: i, edge: 'end', t: cues[i].end });
    }

    // 每个点在容差窗口内的候选帧下标（n 值越大时间越晚），按升序
    const candidates = points.map(pt => {
      const near = pt.t / frameMs;
      const lo = Math.ceil(near - toleranceMs / frameMs - 1e-9);
      const hi = Math.floor(near + toleranceMs / frameMs + 1e-9);
      const out = [];
      for (let k = lo; k <= hi; k++) {
        if (Math.abs(frameEdgeMs(k, frameMs) - pt.t) <= toleranceMs) out.push(k + 0); // -0 -> +0
      }
      return out;
    });

    // 超容差的点：最近的帧也落不进容差窗口
    const conflicts = [];
    candidates.forEach((cand, p) => {
      if (cand.length) return;
      const pt = points[p];
      const nearest = frameEdgeMs(Math.round(pt.t / frameMs), frameMs);
      const delta = Math.abs(nearest - pt.t);
      conflicts.push({
        index: pt.cue,
        message: '第 ' + (pt.cue + 1) + ' 条' + (pt.edge === 'start' ? '起点' : '终点') +
          ' ' + msToTimecode(pt.t) + ' 超出容差：最近帧边界 ' + msToTimecode(nearest) +
          '（偏移 ' + delta + 'ms > ' + toleranceMs + 'ms），请加大单点最大允许偏移',
      });
    });
    if (conflicts.length) return { ok: false, conflicts };

    // 相邻点间最小间隔（ms）：块内为最短时长，块间为最小间隔
    const minGapAt = (p) => (p % 2 === 1 ? MIN_DURATION_MS : MIN_GAP_MS);

    // 动态规划：dp[p][j] = 走到第 p 个点选第 j 个候选帧时的
    //   { cost（到该点为止的最小总偏移）， k（前一点所选候选下标） }
    const dp = [];
    dp.push(candidates[0].map(k => (frameEdgeMs(k, frameMs) >= 0)
      ? { cost: Math.abs(frameEdgeMs(k, frameMs) - points[0].t), k: -1 }
      : null));

    for (let p = 1; p < points.length; p++) {
      const prevLayer = dp[p - 1];
      const prevCand = candidates[p - 1];
      const gap = minGapAt(p);
      const layer = new Array(candidates[p].length).fill(null);
      let scanIdx = -1; // 已纳入窗口的前驱候选扫描位置（无论是否可达都前进）
      let bestIdx = -1; // 窗口内可达且 cost 最小的前驱候选
      for (let j = 0; j < candidates[p].length; j++) {
        const edge = frameEdgeMs(candidates[p][j], frameMs);
        // 新进入窗口的前驱候选：时间上满足 prevEdge <= edge - gap
        while (scanIdx + 1 < prevCand.length &&
               frameEdgeMs(prevCand[scanIdx + 1], frameMs) <= edge - gap) {
          scanIdx++;
          if (prevLayer[scanIdx] &&
              (bestIdx < 0 || prevLayer[scanIdx].cost < prevLayer[bestIdx].cost)) {
            bestIdx = scanIdx;
          }
        }
        if (bestIdx >= 0 && prevLayer[bestIdx]) {
          // 候选按帧下标升序遍历；同分由更靠前（更早）的前驱胜出，故严格小于才更新
          layer[j] = {
            cost: prevLayer[bestIdx].cost + Math.abs(edge - points[p].t),
            k: bestIdx,
          };
        }
      }
      if (!layer.some(Boolean)) {
        const pt = points[p];
        return {
          ok: false,
          conflicts: [{
            index: pt.cue,
            message: '第 ' + (pt.cue + 1) + ' 条' + (pt.edge === 'start' ? '起点' : '终点') +
              ' ' + msToTimecode(pt.t) + ' 在 ' + toleranceMs + 'ms 容差内找不到满足约束' +
              '（每块 ≥' + MIN_DURATION_MS + 'ms、相邻间隔 ≥' + MIN_GAP_MS + 'ms、起点 ≥0）的' +
              '全局对齐方案，请加大单点最大允许偏移或先手动修整时间轴',
          }],
        };
      }
      dp.push(layer);
    }

    // 终点取最优；同样严格更小才更新 → 同分保留更早候选
    const lastLayer = dp[dp.length - 1];
    let bestJ = -1;
    for (let j = 0; j < lastLayer.length; j++) {
      if (lastLayer[j] && (bestJ < 0 || lastLayer[j].cost < lastLayer[bestJ].cost)) bestJ = j;
    }

    // 回溯各点所选帧下标
    const chosenFrames = new Array(points.length);
    let j = bestJ;
    for (let p = points.length - 1; p >= 0; p--) {
      chosenFrames[p] = candidates[p][j];
      j = dp[p][j].k;
    }

    const changes = [];
    let totalDelta = 0;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const start = frameEdgeMs(chosenFrames[2 * i], frameMs);
      const end = frameEdgeMs(chosenFrames[2 * i + 1], frameMs);
      const startDelta = start - cues[i].start;
      const endDelta = end - cues[i].end;
      totalDelta += Math.abs(startDelta) + Math.abs(endDelta);
      maxDelta = Math.max(maxDelta, Math.abs(startDelta), Math.abs(endDelta));
      changes.push({ index: i, start, end, startDelta, endDelta });
    }

    return {
      ok: true,
      fpsLabel: String(fpsLabel),
      frameMs,
      toleranceMs,
      totalDeltaMs: totalDelta,
      maxDeltaMs: maxDelta,
      changes,
    };
  }

  /** 校验当前状态是否满足全部约束，返回问题列表（空数组 = 合法） */
  function validate(cues) {
    const problems = [];
    cues.forEach((c, i) => {
      if (c.start < 0) problems.push('第 ' + (i + 1) + ' 条起点为负');
      if (c.end - c.start < MIN_DURATION_MS) problems.push('第 ' + (i + 1) + ' 条时长不足 500ms');
      if (i > 0 && c.start - cues[i - 1].end < MIN_GAP_MS) {
        problems.push('第 ' + (i + 1) + ' 条与前一条间隔不足 100ms');
      }
    });
    return problems;
  }

  return {
    MIN_DURATION_MS,
    MIN_GAP_MS,
    FRAME_RATES,
    framePeriodMs,
    frameEdgeMs,
    msToTimecode,
    timecodeToMs,
    parseTimeInput,
    parseSrt,
    formatSrt,
    normalize,
    applyDrag,
    applyMove,
    planRetime,
    applyPlan,
    planFrameAlign,
    validate,
  };
});
