/* global SubEngine */
(function () {
  'use strict';

  const {
    MIN_DURATION_MS, MIN_GAP_MS,
    msToTimecode, parseTimeInput, parseSrt, formatSrt, normalize,
    applyDrag, applyMove, planRetime, applyPlan,
    planFrameAlign, applyFramePlan, validate,
  } = SubEngine;

  const MIN_PPS = 10;    // 像素/秒，缩放范围
  const MAX_PPS = 2000;
  const UNDO_LIMIT = 100;

  const state = {
    cues: [],          // [{start, end, text}]
    pxPerSec: 120,
    undoStack: [],     // 每次拖动/变速前的 [{start,end},...] 快照
    selected: -1,
    drag: null,        // {index, edge: 'start'|'end'|'move', moved, grabOffset, el, snapshot}
    retime: null,      // 变速预览中 {plan, backup, affectedSet}
    frame: null,       // 帧对齐预览中 {plan, backup, affectedSet}
    rangeOverlay: null,// 时间轴区间覆盖层 {fromMs, toMs, preview}
    fileName: 'edited.srt',
  };

  // 是否处于“模态预览”中（区间变速 / 帧对齐）：此时禁止拖动、撤销等操作
  function modalOpen() { return !!(state.retime || state.frame); }

  const $ = (sel) => document.querySelector(sel);
  const scroller = $('#timeline-scroll');
  const content = $('#timeline-content');
  const rulerEl = $('#ruler');
  const trackEl = $('#track');
  const listBody = $('#cue-list-body');
  const statusEl = $('#status');
  const emptyHint = $('#empty-hint');
  const fileInput = $('#file-input');
  const zoomSlider = $('#zoom-slider');
  const zoomLabel = $('#zoom-label');

  let blockEls = [];   // 与 state.cues 对应的块元素池
  let rowEls = [];     // 列表行元素池
  let rulerWidth = 0;  // 已渲染刻度的宽度，避免拖动中重复渲染
  let rafPending = false;

  /* ---------------- 渲染 ---------------- */

  function contentWidthPx() {
    let endMs = state.cues.length ? state.cues[state.cues.length - 1].end : 0;
    if (state.rangeOverlay) endMs = Math.max(endMs, state.rangeOverlay.toMs); // 覆盖层不被裁剪
    const w = (endMs + 5000) / 1000 * state.pxPerSec; // 末尾留白 5s
    return Math.max(w, scroller.clientWidth);
  }

  function ensureBlocks() {
    while (blockEls.length < state.cues.length) {
      const i = blockEls.length;
      const el = document.createElement('div');
      el.className = 'block';
      el.dataset.i = i;
      el.title = '按住块主体横向拖动可整块平移（时长不变）';
      el.innerHTML =
        '<div class="handle handle-l" title="拖动调整起点"></div>' +
        '<div class="block-body"><div class="block-time"></div><div class="block-text"></div></div>' +
        '<div class="handle handle-r" title="拖动调整终点"></div>';
      trackEl.appendChild(el);
      blockEls.push(el);
    }
    while (blockEls.length > state.cues.length) trackEl.removeChild(blockEls.pop());
  }

  function ensureRows() {
    while (rowEls.length < state.cues.length) {
      const tr = document.createElement('tr');
      for (let k = 0; k < 5; k++) tr.appendChild(document.createElement('td'));
      tr.addEventListener('click', () => {
        selectCue(rowEls.indexOf(tr));
        scrollBlockIntoView(rowEls.indexOf(tr));
      });
      listBody.appendChild(tr);
      rowEls.push(tr);
    }
    while (rowEls.length > state.cues.length) listBody.removeChild(rowEls.pop());
  }

  function previewAffectedSet() {
    return state.retime ? state.retime.affectedSet
      : state.frame ? state.frame.affectedSet : null;
  }

  function updateBlocks(from) {
    const pps = state.pxPerSec;
    const affected = previewAffectedSet();
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const el = blockEls[i];
      el.style.left = (c.start / 1000 * pps) + 'px';
      el.style.width = ((c.end - c.start) / 1000 * pps) + 'px';
      el.classList.toggle('retime-affected', !!(affected && affected.has(i)));
      el.querySelector('.block-time').textContent =
        msToTimecode(c.start) + ' → ' + msToTimecode(c.end);
      const textEl = el.querySelector('.block-text');
      if (textEl.textContent !== c.text) textEl.textContent = c.text;
    }
  }

  function updateRows(from) {
    const affected = previewAffectedSet();
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const td = rowEls[i].children;
      td[0].textContent = i + 1;
      td[1].textContent = msToTimecode(c.start);
      td[2].textContent = msToTimecode(c.end);
      td[3].textContent = ((c.end - c.start) / 1000).toFixed(3) + 's';
      if (td[4].textContent !== c.text) td[4].textContent = c.text;
      rowEls[i].classList.toggle('retime-affected', !!(affected && affected.has(i)));
    }
  }

  function renderRuler() {
    rulerEl.textContent = '';
    const pps = state.pxPerSec;
    const width = contentWidthPx();
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find(s => s * pps >= 90) || 3600;
    const frag = document.createDocumentFragment();
    for (let t = 0; t * pps <= width; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (t * pps) + 'px';
      const label = document.createElement('span');
      label.textContent = step < 1
        ? msToTimecode(t * 1000).slice(3)          // mm:ss,mmm
        : msToTimecode(t * 1000).replace(/^00:/, ''); // 不足一小时时省略小时
      tick.appendChild(label);
      frag.appendChild(tick);
    }
    rulerEl.appendChild(frag);
    rulerWidth = width;
  }

  function updateStatus() {
    const n = state.cues.length;
    if (!n) {
      statusEl.textContent = '就绪 — 请导入 SRT 文件，或点击「载入示例」';
      return;
    }
    const problems = validate(state.cues);
    statusEl.textContent = problems.length
      ? '⚠ ' + problems[0]
      : '共 ' + n + ' 条 · 结束于 ' + msToTimecode(state.cues[n - 1].end) +
        ' · 缩放 ' + state.pxPerSec + ' px/s · ✓ 约束满足（每块 ≥' + MIN_DURATION_MS +
        'ms，间隔 ≥' + MIN_GAP_MS + 'ms，起点 ≥0）';
    statusEl.classList.toggle('warn', problems.length > 0);
  }

  function updateUndoButton() {
    const btn = $('#btn-undo');
    btn.disabled = state.undoStack.length === 0 || modalOpen(); // 预览期间禁止撤销
    btn.textContent = state.undoStack.length ? '撤销 (' + state.undoStack.length + ')' : '撤销';
  }

  function renderDynamic(from) {
    if (!state.cues.length) return;
    const w = contentWidthPx() + 'px';
    if (content.style.width !== w) content.style.width = w;
    if (parseFloat(w) > rulerWidth) renderRuler(); // 内容变长时补刻度
    updateBlocks(from);
    updateRows(from);
    updateStatus();
  }

  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderDynamic(state.drag ? state.drag.index : 0);
    });
  }

  function renderAll() {
    emptyHint.style.display = state.cues.length ? 'none' : '';
    if (!state.cues.length) {
      trackEl.textContent = ''; blockEls = [];
      listBody.textContent = ''; rowEls = [];
      rulerEl.textContent = ''; rulerWidth = 0;
      positionRangeOverlay();
      updateStatus();
      return;
    }
    ensureBlocks();
    ensureRows();
    content.style.width = contentWidthPx() + 'px';
    renderRuler();
    renderDynamic(0);
    markSelected();
    positionRangeOverlay();
  }

  /* ---------------- 选择 ---------------- */

  function markSelected() {
    blockEls.forEach((el, i) => el.classList.toggle('selected', i === state.selected));
    rowEls.forEach((el, i) => el.classList.toggle('selected', i === state.selected));
  }

  function selectCue(i) {
    state.selected = i;
    markSelected();
    if (rowEls[i]) rowEls[i].scrollIntoView({ block: 'nearest' });
  }

  function scrollBlockIntoView(i) {
    if (!state.cues[i]) return;
    const x = state.cues[i].start / 1000 * state.pxPerSec;
    scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 3);
  }

  /* ---------------- 拖动 ---------------- */

  trackEl.addEventListener('pointerdown', (e) => {
    if (modalOpen()) return; // 预览期间禁止拖动
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;
    const index = Number(blockEl.dataset.i);
    selectCue(index);
    const handle = e.target.closest('.handle');
    // 手柄拖动边界；按住块主体则整块平移（时长不变）
    const edge = handle ? (handle.classList.contains('handle-l') ? 'start' : 'end') : 'move';
    e.preventDefault();
    const rect = content.getBoundingClientRect();
    const t = (e.clientX - rect.left) / state.pxPerSec * 1000;
    state.drag = {
      index,
      edge,
      moved: false,
      grabOffset: edge === 'move' ? t - state.cues[index].start : 0, // 抓取点偏移，避免跳动
      el: blockEl,
      snapshot: state.cues.map(c => ({ start: c.start, end: c.end })),
    };
    if (edge === 'move') blockEl.classList.add('moving');
    blockEl.setPointerCapture(e.pointerId);
  });

  trackEl.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    const rect = content.getBoundingClientRect();
    const t = (e.clientX - rect.left) / state.pxPerSec * 1000;
    if (state.drag.edge === 'move') {
      applyMove(state.cues, state.drag.index, t - state.drag.grabOffset);
    } else {
      applyDrag(state.cues, state.drag.index, state.drag.edge, t);
    }
    state.drag.moved = true;
    // 拖到视口边缘时自动横向滚动
    const sr = scroller.getBoundingClientRect();
    if (e.clientX > sr.right - 40) scroller.scrollLeft += 24;
    else if (e.clientX < sr.left + 40) scroller.scrollLeft -= 24;
    requestRender();
  });

  function finishDrag() {
    if (!state.drag) return;
    if (state.drag.el) state.drag.el.classList.remove('moving');
    if (state.drag.moved) {
      // 一次手势（含中途的推移与回拖）只产生一条撤销记录
      state.undoStack.push(state.drag.snapshot);
      if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
      updateUndoButton();
    }
    state.drag = null;
    renderDynamic(0);
  }
  trackEl.addEventListener('pointerup', finishDrag);
  trackEl.addEventListener('pointercancel', finishDrag);

  /* ---------------- 撤销 ---------------- */

  function undo() {
    if (modalOpen()) return; // 预览期间禁止撤销
    const snap = state.undoStack.pop();
    if (!snap) return;
    state.cues.forEach((c, i) => { c.start = snap[i].start; c.end = snap[i].end; });
    updateUndoButton();
    renderAll();
  }
  $('#btn-undo').addEventListener('click', undo);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      if (state.retime) cancelRetime();       // Esc 取消变速预览
      else if (state.frame) cancelFrame();    // Esc 取消帧对齐预览
    }
  });

  /* ---------------- 区间变速 ---------------- */

  const retimePanel = $('#retime-panel');
  const retimeIn = $('#retime-in');
  const retimeOut = $('#retime-out');
  const retimeTarget = $('#retime-target');
  const retimeInfo = $('#retime-info');
  const retimeConflictsEl = $('#retime-conflicts');
  const rangeOverlay = $('#range-overlay');
  const btnRetimePreview = $('#btn-retime-preview');
  const btnRetimeApply = $('#btn-retime-apply');
  const btnRetimeCancel = $('#btn-retime-cancel');

  function setRetimeInfo(msg, warn) {
    retimeInfo.textContent = msg;
    retimeInfo.classList.toggle('warn', !!warn);
  }

  function clearConflicts() {
    retimeConflictsEl.textContent = '';
  }

  function showConflicts(conflicts) {
    clearConflicts();
    for (const c of conflicts) {
      const li = document.createElement('li');
      li.textContent = '⚠ ' + c.message + '（点击定位）';
      li.addEventListener('click', () => {
        selectCue(c.index);
        scrollBlockIntoView(c.index);
      });
      retimeConflictsEl.appendChild(li);
    }
  }

  function readRetimeParams() {
    return {
      inMs: parseTimeInput(retimeIn.value),
      outMs: parseTimeInput(retimeOut.value),
      targetMs: parseTimeInput(retimeTarget.value),
    };
  }

  function positionRangeOverlay() {
    const r = state.rangeOverlay;
    if (!r || !state.cues.length || r.toMs <= r.fromMs) {
      rangeOverlay.hidden = true;
      return;
    }
    rangeOverlay.hidden = false;
    rangeOverlay.style.left = (r.fromMs / 1000 * state.pxPerSec) + 'px';
    rangeOverlay.style.width = ((r.toMs - r.fromMs) / 1000 * state.pxPerSec) + 'px';
    rangeOverlay.classList.toggle('preview', !!r.preview);
  }

  // 输入入点/出点时实时标出所选区间（预览中则保持显示目标区间）
  function updateRangeOverlayFromInputs() {
    if (state.retime) return;
    const { inMs, outMs } = readRetimeParams();
    state.rangeOverlay = (inMs != null && outMs != null && outMs > inMs)
      ? { fromMs: inMs, toMs: outMs, preview: false }
      : null;
    positionRangeOverlay();
  }

  function setPreviewUi(previewing) {
    btnRetimePreview.disabled = previewing;
    btnRetimeApply.disabled = !previewing;
    btnRetimeCancel.disabled = !previewing;
    retimeIn.disabled = retimeOut.disabled = retimeTarget.disabled = previewing;
    $('#btn-export').disabled = previewing || !!state.frame || !state.cues.length;
    updateUndoButton();
  }

  function openRetimePanel() {
    if (!state.cues.length) {
      statusEl.textContent = '⚠ 请先导入字幕，再使用区间变速';
      statusEl.classList.add('warn');
      return;
    }
    if (state.frame) closeFramePanel(); // 两个工具互斥
    retimePanel.hidden = false;
    // 默认填入选中字幕的范围，未选中则为整个时间轴
    const sel = state.cues[state.selected];
    const inMs = sel ? sel.start : 0;
    const outMs = sel ? sel.end : state.cues[state.cues.length - 1].end;
    retimeIn.value = msToTimecode(inMs);
    retimeOut.value = msToTimecode(outMs);
    retimeTarget.value = ((outMs - inMs) / 1000).toFixed(3);
    clearConflicts();
    setPreviewUi(false);
    setRetimeInfo('设置入点、出点与目标时长后点击「预览」（时间支持 秒 / MM:SS,mmm / HH:MM:SS,mmm）', false);
    updateRangeOverlayFromInputs();
  }

  function closeRetimePanel() {
    if (state.retime) cancelRetime(); // 收起面板视同取消预览
    retimePanel.hidden = true;
    state.rangeOverlay = null;
    positionRangeOverlay();
    clearConflicts();
  }

  // 导入新文件时调用：丢弃预览状态（字幕已被整体替换，无需恢复备份）
  function resetRetime() {
    state.retime = null;
    state.rangeOverlay = null;
    retimePanel.hidden = true;
    clearConflicts();
    setPreviewUi(false);
    positionRangeOverlay();
  }

  function previewRetime() {
    if (state.retime || !state.cues.length) return;
    clearConflicts();
    const { inMs, outMs, targetMs } = readRetimeParams();
    if (inMs == null || outMs == null || targetMs == null) {
      setRetimeInfo('⚠ 时间格式无效：支持纯秒数（如 3.5）、MM:SS,mmm 或 HH:MM:SS,mmm', true);
      return;
    }
    const plan = planRetime(state.cues, inMs, outMs, targetMs);
    if (!plan.ok) {
      if (plan.conflicts) {
        showConflicts(plan.conflicts);
        setRetimeInfo('⚠ 存在 ' + plan.conflicts.length +
          ' 处冲突，未修改任何字幕；点击上方冲突可定位，调整参数后重新预览', true);
      } else {
        setRetimeInfo('⚠ ' + plan.reason, true);
      }
      return;
    }
    // 进入预览：备份现状并应用方案，「取消预览」可原样恢复
    state.retime = {
      plan,
      backup: state.cues.map(c => ({ start: c.start, end: c.end })),
      affectedSet: new Set(plan.affected),
    };
    applyPlan(state.cues, plan);
    state.rangeOverlay = { fromMs: plan.inMs, toMs: plan.newOutMs, preview: true };
    setPreviewUi(true);
    setRetimeInfo(
      '预览中：锚点 ' + msToTimecode(plan.inMs) + ' 不动，缩放 ×' + plan.scale.toFixed(3) +
      '，影响第 ' + (plan.affected[0] + 1) + '–' + (plan.affected[plan.affected.length - 1] + 1) +
      ' 条（共 ' + plan.affected.length + ' 条）。确认后点击「应用变速」，或「取消预览」(Esc) 恢复。', false);
    renderAll();
  }

  function cancelRetime() {
    if (!state.retime) return;
    const backup = state.retime.backup;
    state.cues.forEach((c, i) => { c.start = backup[i].start; c.end = backup[i].end; });
    state.retime = null;
    setPreviewUi(false);
    setRetimeInfo('已取消预览，未修改任何字幕。', false);
    updateRangeOverlayFromInputs();
    renderAll();
  }

  function applyRetime() {
    if (!state.retime) return;
    state.undoStack.push(state.retime.backup); // 一次变速只产生一条撤销记录
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    state.retime = null;
    state.rangeOverlay = null;
    setPreviewUi(false);
    updateUndoButton();
    setRetimeInfo('已应用区间变速。可用「撤销」或 Ctrl+Z 回退。', false);
    renderAll();
  }

  $('#btn-retime').addEventListener('click', () => {
    if (retimePanel.hidden) openRetimePanel(); else closeRetimePanel();
  });
  $('#btn-retime-close').addEventListener('click', closeRetimePanel);
  btnRetimePreview.addEventListener('click', previewRetime);
  btnRetimeApply.addEventListener('click', applyRetime);
  btnRetimeCancel.addEventListener('click', cancelRetime);
  retimeIn.addEventListener('input', updateRangeOverlayFromInputs);
  retimeOut.addEventListener('input', updateRangeOverlayFromInputs);
  [retimeIn, retimeOut, retimeTarget].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') previewRetime();
  }));

  /* ---------------- 帧对齐 ---------------- */

  const framePanel = $('#frame-panel');
  const frameFps = $('#frame-fps');
  const frameTol = $('#frame-tol');
  const frameInfo = $('#frame-info');
  const frameConflictsEl = $('#frame-conflicts');
  const framePreviewEl = $('#frame-preview');
  const framePreviewBody = $('#frame-preview-body');
  const btnFramePreview = $('#btn-frame-preview');
  const btnFrameApply = $('#btn-frame-apply');
  const btnFrameCancel = $('#btn-frame-cancel');

  function setFrameInfo(msg, warn) {
    frameInfo.textContent = msg;
    frameInfo.classList.toggle('warn', !!warn);
  }

  function showFrameConflicts(conflicts) {
    frameConflictsEl.textContent = '';
    for (const c of conflicts) {
      const li = document.createElement('li');
      li.textContent = '⚠ ' + c.message + '（点击定位）';
      li.addEventListener('click', () => {
        selectCue(c.index);
        scrollBlockIntoView(c.index);
      });
      frameConflictsEl.appendChild(li);
    }
  }

  function fmtDelta(ms) {
    const sign = ms > 0 ? '+' : (ms < 0 ? '−' : '');
    return sign + Math.abs(ms) + 'ms';
  }

  function makeDeltaCell(td, ms) {
    td.textContent = fmtDelta(ms);
    td.className = 'delta ' + (ms > 0 ? 'pos' : ms < 0 ? 'neg' : 'zero');
  }

  // 预览逐条显示对齐前后时间码与偏移；点击行定位到该字幕
  function renderFramePreview(plan) {
    framePreviewBody.textContent = '';
    plan.changes.forEach((ch) => {
      const i = ch.index;
      const before = state.frame ? state.frame.backup[i] : state.cues[i];
      const tr = document.createElement('tr');
      for (let k = 0; k < 7; k++) tr.appendChild(document.createElement('td'));
      const td = tr.children;
      td[0].textContent = i + 1;
      td[1].textContent = msToTimecode(before.start);
      td[2].textContent = msToTimecode(ch.start);
      makeDeltaCell(td[3], ch.dStart);
      td[4].textContent = msToTimecode(before.end);
      td[5].textContent = msToTimecode(ch.end);
      makeDeltaCell(td[6], ch.dEnd);
      tr.addEventListener('click', () => {
        selectCue(i);
        scrollBlockIntoView(i);
      });
      framePreviewBody.appendChild(tr);
    });
    framePreviewEl.hidden = false;
  }

  function setFrameUi(previewing) {
    btnFramePreview.disabled = previewing;
    btnFrameApply.disabled = !previewing;
    btnFrameCancel.disabled = !previewing;
    frameFps.disabled = frameTol.disabled = previewing;
    $('#btn-export').disabled = previewing || !!state.retime || !state.cues.length;
    updateUndoButton();
  }

  function openFramePanel() {
    if (!state.cues.length) {
      statusEl.textContent = '⚠ 请先导入字幕，再使用帧对齐';
      statusEl.classList.add('warn');
      return;
    }
    if (state.retime) closeRetimePanel(); // 两个工具互斥
    framePanel.hidden = false;
    frameConflictsEl.textContent = '';
    framePreviewEl.hidden = true;
    setFrameUi(false);
    setFrameInfo('选择帧率并设置单点最大允许偏移（毫秒），点击「预览」查看全局最近帧方案', false);
  }

  function closeFramePanel() {
    if (state.frame) cancelFrame(); // 收起面板视同取消预览
    framePanel.hidden = true;
    frameConflictsEl.textContent = '';
    framePreviewEl.hidden = true;
  }

  // 导入新文件时调用：丢弃预览状态
  function resetFrame() {
    state.frame = null;
    framePanel.hidden = true;
    frameConflictsEl.textContent = '';
    framePreviewEl.hidden = true;
    setFrameUi(false);
  }

  function previewFrame() {
    if (state.frame || !state.cues.length) return;
    frameConflictsEl.textContent = '';
    framePreviewEl.hidden = true;
    const tolRaw = frameTol.value.trim();
    const tol = /^\d+(\.\d+)?$/.test(tolRaw) ? Math.round(Number(tolRaw)) : null; // 纯数字 = 毫秒
    if (tol == null || tol <= 0) {
      setFrameInfo('⚠ 单点最大允许偏移无效：请输入大于 0 的毫秒数（如 50）', true);
      return;
    }
    const plan = planFrameAlign(state.cues, Number(frameFps.value), tol);
    if (!plan.ok) {
      if (plan.conflicts) {
        showFrameConflicts(plan.conflicts);
        setFrameInfo('⚠ 存在 ' + plan.conflicts.length +
          ' 处问题，未修改任何字幕；点击上方条目可定位，调整偏移或先手动修整后重新预览', true);
      } else {
        setFrameInfo('⚠ ' + plan.reason, true);
      }
      return;
    }
    // 进入预览：备份现状并应用方案，「取消预览」可原样恢复
    state.frame = {
      plan,
      backup: state.cues.map(c => ({ start: c.start, end: c.end })),
      affectedSet: new Set(plan.changes.filter(c => c.dStart !== 0 || c.dEnd !== 0)
        .map(c => c.index)),
    };
    applyFramePlan(state.cues, plan);
    setFrameUi(true);
    setFrameInfo(
      '预览中：' + frameFps.options[frameFps.selectedIndex].text +
      '，单点偏移 ≤' + plan.toleranceMs + 'ms；总绝对偏移 ' + plan.totalOffsetMs +
      'ms，最大单点偏移 ' + plan.maxOffsetMs + 'ms（同分方案已取最早时间）。' +
      '确认后点击「应用对齐」，或「取消预览」(Esc) 恢复。', false);
    renderAll();
    renderFramePreview(plan);
  }

  function cancelFrame() {
    if (!state.frame) return;
    const backup = state.frame.backup;
    state.cues.forEach((c, i) => { c.start = backup[i].start; c.end = backup[i].end; });
    state.frame = null;
    framePreviewEl.hidden = true;
    setFrameUi(false);
    setFrameInfo('已取消预览，未修改任何字幕。', false);
    renderAll();
  }

  function applyFrame() {
    if (!state.frame) return;
    state.undoStack.push(state.frame.backup); // 一次对齐只产生一条撤销记录
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    state.frame = null;
    framePreviewEl.hidden = true;
    setFrameUi(false);
    updateUndoButton();
    setFrameInfo('已应用帧对齐。可用「撤销」或 Ctrl+Z 回退。', false);
    renderAll();
  }

  $('#btn-frame').addEventListener('click', () => {
    if (framePanel.hidden) openFramePanel(); else closeFramePanel();
  });
  $('#btn-frame-close').addEventListener('click', closeFramePanel);
  btnFramePreview.addEventListener('click', previewFrame);
  btnFrameApply.addEventListener('click', applyFrame);
  btnFrameCancel.addEventListener('click', cancelFrame);
  frameTol.addEventListener('keydown', (e) => { if (e.key === 'Enter') previewFrame(); });

  /* ---------------- 缩放 ---------------- */

  const sliderToPps = (v) => Math.round(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100));
  const ppsToSlider = (p) => Math.round(100 * Math.log(p / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS));

  function setPps(pps, anchorClientX) {
    const rect = scroller.getBoundingClientRect();
    const anchorX = anchorClientX != null ? anchorClientX - rect.left : scroller.clientWidth / 2;
    const timeAtAnchor = (scroller.scrollLeft + anchorX) / state.pxPerSec;
    state.pxPerSec = Math.min(MAX_PPS, Math.max(MIN_PPS, Math.round(pps)));
    zoomSlider.value = ppsToSlider(state.pxPerSec);
    zoomLabel.textContent = state.pxPerSec + ' px/s';
    renderAll();
    scroller.scrollLeft = timeAtAnchor * state.pxPerSec - anchorX;
  }

  $('#btn-zoom-in').addEventListener('click', () => setPps(state.pxPerSec * 1.25));
  $('#btn-zoom-out').addEventListener('click', () => setPps(state.pxPerSec / 1.25));
  $('#btn-zoom-fit').addEventListener('click', fitZoom);
  zoomSlider.addEventListener('input', () => setPps(sliderToPps(Number(zoomSlider.value))));
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setPps(state.pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX);
  }, { passive: false });

  function fitZoom() {
    if (!state.cues.length) return;
    const totalSec = (state.cues[state.cues.length - 1].end + 2000) / 1000;
    setPps((scroller.clientWidth - 20) / totalSec);
    scroller.scrollLeft = 0;
  }

  /* ---------------- 导入 / 导出 ---------------- */

  function importText(text, name) {
    const cues = normalize(parseSrt(text));
    if (!cues.length) {
      statusEl.textContent = '⚠ 未能从「' + name + '」解析出任何字幕';
      statusEl.classList.add('warn');
      return;
    }
    resetRetime(); // 新文件替换全部字幕，丢弃未确认的变速预览
    resetFrame();  // 丢弃未确认的帧对齐预览
    state.cues = cues;
    state.fileName = name.replace(/\.[^.]*$/, '') + '.srt';
    state.undoStack = [];
    state.selected = -1;
    updateUndoButton();
    $('#btn-export').disabled = false;
    renderAll();
    fitZoom();
  }

  $('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), f.name);
    reader.readAsText(f);
    fileInput.value = '';
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), f.name);
    reader.readAsText(f);
  });

  $('#btn-export').addEventListener('click', () => {
    if (!state.cues.length) return;
    const problems = validate(state.cues);
    if (problems.length) {
      alert('时间轴不合法，无法导出：\n' + problems.join('\n'));
      return;
    }
    const blob = new Blob([formatSrt(state.cues)], { type: 'application/x-subrip;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- 示例 ---------------- */

  $('#btn-demo').addEventListener('click', () => {
    importText([
      '1', '00:00:00,000 --> 00:00:01,800', '欢迎来到字幕时间轴修整器', '',
      '2', '00:00:02,000 --> 00:00:04,200', '拖动左右边界调整起止，按住块主体可整块平移', '',
      '3', '00:00:04,500 --> 00:00:06,000', '右边界越过安全线时会递归推移后继块', '',
      '4', '00:00:06,200 --> 00:00:08,500', '向回拖动只释放空隙，不会拉回后继', '',
      '5', '00:00:08,800 --> 00:00:11,000', '每块至少 500ms，块间至少 100ms，起点不为负', '',
      '6', '00:00:11,300 --> 00:00:13,600', 'Ctrl+滚轮缩放时间轴，Ctrl+Z 撤销操作', '',
      '7', '00:00:13,900 --> 00:00:16,500', '「区间变速」设置入点、出点与目标时长，预览确认后应用', '',
      '8', '00:00:16,800 --> 00:00:19,200', '完成后点击「导出 SRT」保存合法字幕文件', '',
    ].join('\n'), 'demo.srt');
  });

  window.addEventListener('resize', () => { if (state.cues.length) renderAll(); });

  zoomSlider.value = ppsToSlider(state.pxPerSec);
  zoomLabel.textContent = state.pxPerSec + ' px/s';
  renderAll();
})();
