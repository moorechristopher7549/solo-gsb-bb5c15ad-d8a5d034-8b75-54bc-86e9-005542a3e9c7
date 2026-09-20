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
 *   - 全部起止点都必须落在所选帧率（23.976/24/25/29.97/30）的帧边界上；
 *   - 在每块 ≥500ms、相邻间隔 ≥100ms、起点 ≥0、顺序不变的前提下，
 *     求总绝对偏移最小的全局方案（相邻点冲突时联动选择相邻帧）；
 *   - 总偏移相同取时间最早的方案（按时间顺序逐点取最早可行帧）；
 *   - 任一点最近帧超出单点容差，或容差窗口内无可行链式方案时，
 *     不修改任何字幕并返回可定位到条目的冲突列表。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MIN_DURATION_MS = 500;
  const MIN_GAP_MS = 100;

  // 支持的帧率：23.976 / 29.97 取精确 NTSC 分数（24000/1001、30000/1001 fps）。
  // num/den 为“每帧毫秒数”（帧率的倒数 ×1000），帧 k 边界 = k*num/den 四舍五入到 ms
  // （与 SRT 毫秒精度一致）：24fps=1000/24、25fps=40、23.976=1001/24、29.97=1001/30。
  const FRAME_RATES = {
    23.976: { num: 1001, den: 24,    label: '23.976 fps' },
    24:     { num: 1000, den: 24,    label: '24 fps' },
    25:     { num: 40,   den: 1,     label: '25 fps' },
    29.97:  { num: 1001, den: 30,    label: '29.97 fps' },
    30:     { num: 1000, den: 30,    label: '30 fps' },
  };

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

  /** 帧号 k 对应的帧边界时间（ms，四舍五入到整数毫秒） */
  function frameToMs(k, rate) {
    return Math.round(k * rate.num / rate.den);
  }

  /**
   * 规划帧对齐（纯函数，不修改 cues）。
   *
   * 把全部起止点按时间顺序视为一条链，每个点都必须取容差窗口
   * [t-tol, t+tol] 内的帧边界；相邻帧号还须满足最小间隔：
   * 同一条的起止 ≥ MIN_DURATION_MS，相邻条 ≥ MIN_GAP_MS，起点 ≥0。
   * 用动态规划求总绝对偏移（ms）最小的全局方案；成本相同按时间顺序
   * 逐点取最早帧（正向重建时在最优后缀中选最小帧）。
   *
   * @returns 成功 { ok: true, fps, toleranceMs, totalOffsetMs, maxOffsetMs, changes }
   *          失败 { ok: false, reason } 或 { ok: false, conflicts: [{index, message}] }
   */
  function planFrameAlign(cues, fps, toleranceMs) {
    const rate = FRAME_RATES[fps];
    if (!rate) return { ok: false, reason: '不支持的帧率：' + fps };
    toleranceMs = Math.round(Number(toleranceMs));
    if (!(toleranceMs > 0)) return { ok: false, reason: '单点最大允许偏移必须大于 0' };
    if (!cues.length) return { ok: false, reason: '没有需要对齐的字幕' };

    const n = cues.length;

    // 时间顺序上的点：p=2i 起点，p=2i+1 终点
    const orig = [];
    for (const c of cues) { orig.push(c.start, c.end); }
    const P = orig.length;
    const minGapMs = [];   // points[p] 相对 points[p-1] 的最小时间间隔（ms）
    for (let p = 0; p < P; p++) {
      minGapMs.push((p % 2 === 1) ? MIN_DURATION_MS : (p > 0 ? MIN_GAP_MS : 0));
    }

    // 每个点的候选帧边界（容差窗口内，SRT 毫秒精度），按帧号升序。
    // frameToMs 随帧号严格递增（帧周期 ≥ 33.3ms，四舍五入到 ms 不会重复）。
    const candidates = [];
    for (let p = 0; p < P; p++) {
      const lo = p === 0 ? Math.max(0, orig[p] - toleranceMs) : orig[p] - toleranceMs;
      const hi = orig[p] + toleranceMs;
      let k = Math.round(orig[p] * rate.den / rate.num); // 距该点最近的帧号
      while (k > 0 && frameToMs(k - 1, rate) >= lo) k--; // 回退到窗口左界
      const list = [];
      while (frameToMs(k, rate) < lo) k++;
      for (; ; k++) {
        const t = frameToMs(k, rate);
        if (t > hi) break;
        list.push({ k, t });
      }
      candidates.push(list);
    }

    // 第一类冲突：某点的容差窗口内连一个帧边界都没有
    const conflicts = [];
    for (let p = 0; p < P; p++) {
      if (!candidates[p].length) {
        const i = p >> 1;
        const edge = (p % 2 === 0) ? '起点' : '终点';
        // 最近的帧边界与该点的距离（供提示参考）
        const kNear = Math.round(orig[p] * rate.den / rate.num);
        const nearest = Math.min(...[kNear - 1, kNear, kNear + 1]
          .filter(k => k >= 0).map(k => Math.abs(frameToMs(k, rate) - orig[p])));
        conflicts.push({
          index: i,
          message: '第 ' + (i + 1) + ' 条' + edge + ' ' + msToTimecode(orig[p]) +
            ' 在 ±' + toleranceMs + 'ms 内无帧边界（最近帧仍偏离 ' + nearest +
            'ms），请放宽单点最大允许偏移',
        });
      }
    }

    // 第二类冲突：窗口各自有点，但在最小间隔约束下链式无可行解。
    // 正向贪心（逐点取满足前驱的最早帧）即可判定整链可行性。
    if (!conflicts.length) {
      let prevT = -Infinity;
      for (let p = 0; p < P; p++) {
        const need = (p === 0) ? 0 : prevT + minGapMs[p];
        const pick = candidates[p].find(c => c.t >= need);
        if (!pick) {
          const i = p >> 1;
          conflicts.push({
            index: i,
            message: '第 ' + (i + 1) + ' 条' + ((p % 2 === 0) ? '起点' : '终点') + ' ' +
              msToTimecode(orig[p]) + ' 在 ±' + toleranceMs +
              'ms 容差内无法与前面的字幕同时满足（每块 ≥' + MIN_DURATION_MS +
              'ms、相邻间隔 ≥' + MIN_GAP_MS + 'ms）约束，请放宽容差或先手动调整该处字幕',
          });
          // 为让贪心继续定位后续冲突，放松该点后继续扫描
          prevT = candidates[p][candidates[p].length - 1].t;
        } else {
          prevT = pick.t;
        }
      }
    }
    if (conflicts.length) return { ok: false, conflicts };

    /*
     * 全局最优：沿链动态规划（保留全部层表供正向重建）。
     *   B[p][j] = 点 p 取第 j 个候选帧时，点 p..P-1 的最小总绝对偏移
     * 转移：B[p][j] = cost(p,j) + min{ B[p+1][q] : t[q] >= t[j] + minGap }
     * 候选按帧号升序，用后缀最小 + 二分查找，整体 O(P·C·log C)。
     * 正向重建时在保持总成本最优的候选里选帧号最小的，
     * 实现“同分优先较早时间”（等价于按时间顺序的字典序最小解）。
     */
    const costAt = (p, c) => Math.abs(c.t - orig[p]);
    const tables = new Array(P);
    for (let p = P - 1; p >= 0; p--) {
      const cur = candidates[p];
      const m = cur.length;
      const b = new Float64Array(m);
      if (p === P - 1) {
        for (let j = 0; j < m; j++) b[j] = costAt(p, cur[j]);
      } else {
        const next = candidates[p + 1];
        const gap = minGapMs[p + 1];
        const prevTable = tables[p + 1];
        // 后缀最小：suf[q] = min(prevTable[q..])
        const suf = new Float64Array(prevTable.length);
        suf[suf.length - 1] = prevTable[prevTable.length - 1];
        for (let q = prevTable.length - 2; q >= 0; q--) {
          suf[q] = Math.min(prevTable[q], suf[q + 1]);
        }
        for (let j = 0; j < m; j++) {
          const need = cur[j].t + gap;
          // 首个 t >= need 的后继候选
          let lo2 = 0, hi2 = next.length;
          while (lo2 < hi2) {
            const mid = (lo2 + hi2) >> 1;
            if (next[mid].t >= need) hi2 = mid; else lo2 = mid + 1;
          }
          b[j] = lo2 < next.length ? (costAt(p, cur[j]) + suf[lo2]) : Infinity;
        }
      }
      tables[p] = b;
    }

    // 正向重建：逐点选满足前驱、且能达到全局最小成本的最早帧
    const rootBest = tables[0].reduce((a, v) => Math.min(a, v), Infinity);
    const chosenT = new Array(P);
    let spent = 0;             // 已选点累计成本
    let prevPickedT = -Infinity;
    for (let p = 0; p < P; p++) {
      const cur = candidates[p];
      const need = (p === 0) ? 0 : prevPickedT + minGapMs[p];
      let picked = -1;
      for (let j = 0; j < cur.length; j++) { // 候选升序，首个即最早帧
        if (cur[j].t < need) continue;
        if (spent + tables[p][j] === rootBest) { picked = j; break; }
      }
      if (picked < 0) {
        // 理论上不可达：贪心已确认可行，DP 必有最优解
        return {
          ok: false,
          conflicts: [{ index: 0, message: '帧对齐无可行方案，请放宽单点最大允许偏移' }],
        };
      }
      chosenT[p] = cur[picked].t;
      prevPickedT = chosenT[p];
      spent += costAt(p, cur[picked]);
    }

    // 汇总为逐字幕方案
    const changes = [];
    let maxOffset = 0;
    for (let i = 0; i < n; i++) {
      const start = chosenT[2 * i];
      const end = chosenT[2 * i + 1];
      const ds = start - cues[i].start;
      const de = end - cues[i].end;
      maxOffset = Math.max(maxOffset, Math.abs(ds), Math.abs(de));
      changes.push({ index: i, start, end, dStart: ds, dEnd: de });
    }

    return {
      ok: true,
      fps,
      toleranceMs,
      totalOffsetMs: rootBest,
      maxOffsetMs: maxOffset,
      changes,
    };
  }

  /** 应用帧对齐方案 */
  function applyFramePlan(cues, plan) {
    if (!plan || !plan.ok) return cues;
    for (const ch of plan.changes) {
      const c = cues[ch.index];
      if (c) { c.start = ch.start; c.end = ch.end; }
    }
    return cues;
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
    frameToMs,
    planFrameAlign,
    applyFramePlan,
    validate,
  };
});
