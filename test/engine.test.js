'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

const cue = (start, end, text = 'x') => ({ start, end, text });

test('时间码互转', () => {
  assert.equal(E.msToTimecode(0), '00:00:00,000');
  assert.equal(E.msToTimecode(3723456), '01:02:03,456');
  assert.equal(E.timecodeToMs('01:02:03,456'), 3723456);
  assert.equal(E.timecodeToMs('00:00:01.500'), 1500); // 兼容句点
  assert.equal(E.timecodeToMs('bad'), null);
});

test('解析 SRT：序号可选、多行文本、CRLF、结束码后带设置', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n世界\r\n\r\n' +
              '00:00:03,000 --> 00:00:04,000 X1:abc\r\n第二块\r\n';
  const cues = E.parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 2000, text: '你好\n世界' });
  assert.equal(cues[1].start, 3000);
  assert.equal(cues[1].text, '第二块');
});

test('解析 SRT：忽略 BOM', () => {
  const cues = E.parseSrt('﻿1\n00:00:00,000 --> 00:00:01,000\n带 BOM\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '带 BOM');
});

test('导出 SRT：序号重排、格式合法且可回读', () => {
  const cues = [cue(0, 1500, '甲'), cue(1600, 2100, '乙\n两行')];
  const out = E.formatSrt(cues);
  assert.equal(out, '1\n00:00:00,000 --> 00:00:01,500\n甲\n\n' +
                    '2\n00:00:01,600 --> 00:00:02,100\n乙\n两行\n');
  assert.deepEqual(E.parseSrt(out), cues);
});

test('normalize：修正负起点、短时长、重叠与乱序', () => {
  const cues = E.normalize([
    cue(2000, 2100, 'c'),   // 时长不足 500
    cue(-300, 400, 'a'),    // 负起点
    cue(450, 1200, 'b'),    // 与 a 间隔不足
  ]);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 700],     // a: 负起点整体平移归零，保持 700 时长
    [800, 1550],  // b: 保持 750 时长整体后移
    [2000, 2500], // c: 位置不变，补足最短时长
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('右边界越过安全线：超出量递归推移后继并保持时长', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyDrag(cues, 0, 'end', 1500);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1500],
    [1600, 2200], // 整体 +900，时长 600 不变
    [2300, 2900], // 连锁 +900
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('连锁在空隙足够处停止', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(5000, 5600)];
  E.applyDrag(cues, 0, 'end', 1500);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1500],
    [1600, 2200],
    [5000, 5600], // 空隙足够，不受影响
  ]);
});

test('向回拖动只释放空隙，不拉回后继', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyDrag(cues, 0, 'end', 1500); // 先推过去
  E.applyDrag(cues, 0, 'end', 800);  // 再拖回来
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 800],
    [1600, 2200], // 后继保持不动
    [2300, 2900],
  ]);
});

test('右边界不得小于最短时长', () => {
  const cues = [cue(1000, 3000)];
  E.applyDrag(cues, 0, 'end', 1100);
  assert.deepEqual([cues[0].start, cues[0].end], [1000, 1500]);
});

test('左边界：夹取于 0、前驱安全线与最短时长', () => {
  const cues = [cue(0, 600), cue(700, 3000)];
  E.applyDrag(cues, 1, 'start', -500);           // 越过 0 与前驱安全线
  assert.equal(cues[1].start, 700);              // prev.end + 100
  E.applyDrag(cues, 1, 'start', 2900);           // 越过 end - 500
  assert.equal(cues[1].start, 2500);
  E.applyDrag(cues, 0, 'start', -100);           // 首块不能为负
  assert.equal(cues[0].start, 0);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：时长不变，向左夹取于 0 与前驱安全线', () => {
  const cues = [cue(0, 600), cue(1000, 3000)];
  E.applyMove(cues, 1, 500);                     // 越过前驱安全线 700
  assert.deepEqual([cues[1].start, cues[1].end], [700, 2700]);  // 时长 2000 不变
  E.applyMove(cues, 0, -800);                    // 首块夹取到 0
  assert.deepEqual([cues[0].start, cues[0].end], [0, 600]);
  E.applyMove(cues, 1, 1200);                    // 正常平移
  assert.deepEqual([cues[1].start, cues[1].end], [1200, 3200]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：向右越过后继安全线递归推移并保持各块时长', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000), cue(5000, 5800)];
  E.applyMove(cues, 0, 1000);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [1000, 1600], // 时长 600 不变
    [1700, 2300], // 被推移，时长 600 不变
    [2400, 3000], // 连锁推移
    [5000, 5800], // 空隙足够，不受影响
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：空隙足够时不影响后继', () => {
  const cues = [cue(0, 600), cue(2000, 2600)];
  E.applyMove(cues, 0, 800);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[800, 1400], [2000, 2600]]);
});

test('整块平移：一次手势内先右推再左回拖，后继不自动回拉', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyMove(cues, 0, 1000); // 先向右推开后继
  E.applyMove(cues, 0, 200);  // 再向左回拖
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [200, 800],
    [1700, 2300], // 后继保持被推开后的位置
    [2400, 3000],
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：中间块向右推动两侧后继，向左仍受前驱约束', () => {
  const cues = [cue(0, 600), cue(1000, 1600), cue(1700, 2300)];
  E.applyMove(cues, 1, 1500); // 越过 cue2 安全线
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 600],
    [1500, 2100],
    [2200, 2800], // 被推移，时长 600 不变
  ]);
  E.applyMove(cues, 1, 100);  // 回拖，夹取于前驱安全线 700；后继不回拉
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 600],
    [700, 1300],
    [2200, 2800],
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('validate 能发现全部三类违规', () => {
  const problems = E.validate([cue(-1, 200), cue(250, 400)]);
  // 负起点 + 第一块时长不足 + 第二块时长不足 + 间隔不足
  assert.equal(problems.length, 4);
});

/* ---------------- 区间变速 ---------------- */

test('parseTimeInput：纯秒数、MM:SS、HH:MM:SS、毫秒与非法输入', () => {
  assert.equal(E.parseTimeInput('3.5'), 3500);
  assert.equal(E.parseTimeInput('90'), 90000);
  assert.equal(E.parseTimeInput('02:03'), 123000);
  assert.equal(E.parseTimeInput('02:03,500'), 123500);
  assert.equal(E.parseTimeInput('1:02:03.456'), 3723456);
  assert.equal(E.parseTimeInput(' 2.5 '), 2500);
  assert.equal(E.parseTimeInput('bad'), null);
  assert.equal(E.parseTimeInput(''), null);
  assert.equal(E.parseTimeInput(null), null);
});

test('区间变速：区间内字幕按锚点线性映射，区间外不动，文本与顺序保持', () => {
  const cues = [cue(0, 1000, 'a'), cue(2000, 3000, 'b'), cue(4000, 5000, 'c'), cue(6000, 7000, 'd')];
  const plan = E.planRetime(cues, 2000, 5000, 1500); // 压缩一半
  assert.equal(plan.ok, true);
  assert.equal(plan.scale, 0.5);
  assert.deepEqual(plan.affected, [1, 2]);
  assert.equal(plan.newOutMs, 3500);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1000],      // 区间外不动
    [2000, 2500],   // 锚点 2000 不动，时长 1000 -> 500
    [3000, 3500],   // 4000->3000，出点 5000->3500
    [6000, 7000],   // 区间外不动
  ]);
  assert.deepEqual(cues.map(c => c.text), ['a', 'b', 'c', 'd']); // 文本与相对顺序保持
  assert.deepEqual(E.validate(cues), []);
});

test('区间变速：跨越边界的字幕只映射区间内端点', () => {
  const cues = [cue(0, 2500), cue(3000, 4000), cue(4500, 8000)];
  const plan = E.planRetime(cues, 2000, 5000, 1500); // scale 0.5
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.affected, [0, 1, 2]);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 2250],      // 跨左边界：起点不动，终点 2500 -> 2250
    [2500, 3000],   // 区间内整体映射
    [3250, 8000],   // 跨右边界：起点 4500 -> 3250，终点不动
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('区间变速：完整覆盖区间的字幕端点均在区间外，保持不动', () => {
  const cues = [cue(0, 10000)];
  const plan = E.planRetime(cues, 2000, 5000, 1500);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.affected, [0]);
  E.applyPlan(cues, plan);
  assert.deepEqual([cues[0].start, cues[0].end], [0, 10000]);
});

test('区间变速：映射后自动补足最短时长', () => {
  const cues = [cue(2000, 3000)];
  const plan = E.planRetime(cues, 2000, 4000, 600); // 时长 1000 -> 300，不足 500
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  assert.deepEqual([cues[0].start, cues[0].end], [2000, 2500]); // 补足到 500ms
  assert.deepEqual(E.validate(cues), []);
});

test('区间变速：映射后自动后移间隔不足的受影响后继（保持时长）', () => {
  const cues = [cue(2000, 3000), cue(3100, 4100)];
  const plan = E.planRetime(cues, 2000, 4100, 630); // scale 0.3
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [2000, 2500],   // 300 -> 补足 500
    [2600, 3100],   // 间隔不足 100ms，整体后移并保持 500 时长
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('区间变速：拉伸后与区间外后继间隔不足 -> 可定位冲突，不静默改写', () => {
  const cues = [cue(2000, 3000), cue(4050, 5000, '外')];
  const before = JSON.parse(JSON.stringify(cues));
  const plan = E.planRetime(cues, 2000, 3000, 2000); // 第一条终点 -> 4000
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].index, 1);          // 可定位到区间外那条
  assert.match(plan.conflicts[0].message, /第 2 条/);
  assert.match(plan.conflicts[0].message, /间隔不足 100ms/);
  assert.deepEqual(cues, before);                      // 纯函数：区间内外均未改写
});

test('区间变速：压缩后与区间外前驱间隔不足 -> 可定位冲突', () => {
  const cues = [cue(0, 1960), cue(2100, 3000)];
  const plan = E.planRetime(cues, 2000, 3000, 500); // 第二条起点 -> 2050，间隔 90ms
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].index, 1);
  assert.match(plan.conflicts[0].message, /第 2 条/);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[0, 1960], [2100, 3000]]); // 未被修改
});

test('区间变速：区间外终点被新区间吞没 -> 冲突而非静默截断', () => {
  const cues = [cue(2100, 2600)]; // 终点 2600 在出点 2400 之外
  const plan = E.planRetime(cues, 2000, 2400, 5000); // 映射起点 3250 越过终点
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts[0].index, 0);
  assert.match(plan.conflicts[0].message, /第 1 条/);
  assert.deepEqual([cues[0].start, cues[0].end], [2100, 2600]);
});

test('区间变速：参数错误与空区间', () => {
  const cues = [cue(0, 1000)];
  assert.match(E.planRetime(cues, -5, 1000, 500).reason, /入点不能为负/);
  assert.match(E.planRetime(cues, 3000, 2000, 500).reason, /出点必须大于入点/);
  assert.match(E.planRetime(cues, 0, 1000, 0).reason, /目标时长必须大于 0/);
  assert.match(E.planRetime(cues, 5000, 6000, 500).reason, /区间内没有字幕/);
});

test('区间变速：应用方案后整体合法且可导出回读', () => {
  const cues = E.normalize(E.parseSrt([
    '1', '00:00:00,000 --> 00:00:01,000', '甲', '',
    '2', '00:00:02,000 --> 00:00:03,000', '乙', '',
    '3', '00:00:04,000 --> 00:00:05,000', '丙', '',
  ].join('\n')));
  const plan = E.planRetime(cues, 1500, 5000, 7000); // 拉伸一倍
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1000],      // 区间外不动
    [2500, 4500],   // 2000->2500，3000->4500
    [6500, 8500],   // 4000->6500，5000->8500
  ]);
  assert.deepEqual(E.validate(cues), []);
  assert.deepEqual(E.parseSrt(E.formatSrt(cues)), cues); // 导出可回读
});

/* ---------------- 帧对齐 ---------------- */

test('帧周期：五种帧率与非法标签', () => {
  assert.equal(E.framePeriodMs('25'), 40);
  assert.ok(Math.abs(E.framePeriodMs('24') - 1000 / 24) < 1e-9);
  assert.ok(Math.abs(E.framePeriodMs('23.976') - 1001000 / 24000) < 1e-9);
  assert.ok(Math.abs(E.framePeriodMs('29.97') - 1001000 / 30000) < 1e-9);
  assert.equal(E.framePeriodMs('12'), null);
});

test('帧对齐：25fps 边界吸附到最近帧，全部点落在帧边界上', () => {
  const cues = [cue(10, 530, 'a'), cue(630, 1200, 'b')];
  const plan = E.planFrameAlign(cues, '25', 20);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes.map(ch => [ch.start, ch.end]), [
    [0, 520],      // 10 -> 0，530 -> 520
    [640, 1200],   // 630 -> 640，1200 已在帧上
  ]);
  assert.deepEqual(plan.changes.map(ch => [ch.startDelta, ch.endDelta]), [
    [-10, -10],
    [10, 0],
  ]);
  assert.equal(plan.totalDeltaMs, 30);
  assert.equal(plan.maxDeltaMs, 10);
  E.applyPlan(cues, plan);
  assert.deepEqual(E.validate(cues), []);
  for (const c of cues) {
    assert.equal(c.start % 40, 0);
    assert.equal(c.end % 40, 0);
  }
});

test('帧对齐：纯函数，规划不修改输入', () => {
  const cues = [cue(10, 530), cue(630, 1200)];
  const before = JSON.parse(JSON.stringify(cues));
  E.planFrameAlign(cues, '25', 20);
  assert.deepEqual(cues, before);
});

test('帧对齐：相邻点冲突时联动选择相邻帧（全局最优而非各自最近）', () => {
  // 25fps：各自最近为 s0=640(-5)、e0=1360(+5)、s1=1440(-5)，间隔 80 < 100
  const cues = [cue(645, 1355), cue(1445, 2045)];
  assert.ok(1440 - 1360 < 100); // 贪心方案必然冲突
  const plan = E.planFrameAlign(cues, '25', 35);
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [640, 1320],   // 终点由 1360 联动前移到 1320
    [1440, 2040],  // 间隔 120 >= 100，时长 600 >= 500
  ]);
  assert.equal(plan.totalDeltaMs, 5 + 35 + 5 + 5);
  assert.equal(plan.maxDeltaMs, 35);
  assert.deepEqual(E.validate(cues), []);
});

test('帧对齐：总偏移同分时取整体较早方案（帧下标向量字典序最小）', () => {
  // 25fps：20 距 0/40 同为 20ms；540 距 520/560 同为 20ms
  // 可行最优组合 [0,520]/[0,560]/[40,560] 总偏移均为 40ms，应取最早的 [0,520]
  const cues = [cue(20, 540)];
  const plan = E.planFrameAlign(cues, '25', 20);
  assert.equal(plan.ok, true);
  assert.equal(plan.totalDeltaMs, 40);
  E.applyPlan(cues, plan);
  assert.deepEqual([cues[0].start, cues[0].end], [0, 520]);
});

test('帧对齐：任一点超出容差 -> 可定位冲突，不修改字幕', () => {
  const cues = [cue(20, 600)]; // 起点 20 距最近帧边界 0/40 均为 20ms
  const before = JSON.parse(JSON.stringify(cues));
  const plan = E.planFrameAlign(cues, '25', 19); // 19ms 容差放不下
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].index, 0);
  assert.match(plan.conflicts[0].message, /第 1 条起点/);
  assert.match(plan.conflicts[0].message, /超出容差/);
  assert.deepEqual(cues, before);
});

test('帧对齐：容差内无可行方案（间隔约束无法满足）-> 冲突', () => {
  // 25fps 两块间隔仅 60ms：±20 窗口内所有帧组合的间隔都凑不足 100ms
  const cues = [cue(400, 1000), cue(1060, 1600)];
  const before = JSON.parse(JSON.stringify(cues));
  const plan = E.planFrameAlign(cues, '25', 20);
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts[0].index, 1);
  assert.match(plan.conflicts[0].message, /第 2 条起点/);
  assert.deepEqual(cues, before); // 未修改
});

test('帧对齐：容差放大后可行且保持全部约束与原顺序', () => {
  // 同上间隔 60ms：容差放大到 40ms 后，可联动到间隔 120ms 的帧组合
  const cues = [cue(400, 1000, '前'), cue(1060, 1600, '后')];
  const plan = E.planFrameAlign(cues, '25', 40);
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[400, 960], [1080, 1600]]);
  assert.deepEqual(cues.map(c => c.text), ['前', '后']);
  assert.deepEqual(E.validate(cues), []);
});

test('帧对齐：非法帧率、非法容差与空字幕', () => {
  assert.match(E.planFrameAlign([cue(0, 500)], '12', 20).reason, /不支持的帧率/);
  assert.match(E.planFrameAlign([cue(0, 500)], '25', -1).reason, /整数毫秒/);
  assert.match(E.planFrameAlign([cue(0, 500)], '25', 1.5).reason, /整数毫秒/);
  assert.match(E.planFrameAlign([], '25', 20).reason, /没有字幕/);
});

test('帧对齐：30fps 吸附结果可导出回读', () => {
  const cues = E.normalize(E.parseSrt([
    '1', '00:00:00,010 --> 00:00:01,200', '甲', '',
    '2', '00:00:01,305 --> 00:00:02,610', '乙', '',
  ].join('\n')));
  const plan = E.planFrameAlign(cues, '30', 20);
  assert.equal(plan.ok, true);
  E.applyPlan(cues, plan);
  const f = 1000 / 30;
  for (const c of cues) {
    assert.ok(Math.abs(c.start - Math.round(c.start / f) * f) < 0.51);
    assert.ok(Math.abs(c.end - Math.round(c.end / f) * f) < 0.51);
  }
  assert.deepEqual(E.validate(cues), []);
  assert.deepEqual(E.parseSrt(E.formatSrt(cues)), cues);
});

test('帧对齐：DP 与全枚举暴力对拍（总偏移最小 + 同分较早）', () => {
  const frameMs = 40;
  const edge = (n) => Math.round(n * frameMs);
  // 小规模随机实例：对每个点枚举容差窗口内的帧，全组合搜索字典序最早的最优解
  for (let seed = 0; seed < 200; seed++) {
    let r = seed * 1103515245 + 12345;
    const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const n = 1 + Math.floor(rand() * 4);
    const cues = [];
    let pos = 100;
    for (let i = 0; i < n; i++) {
      const start = pos + Math.floor(rand() * 40);
      const end = start + 500 + Math.floor(rand() * 300);
      cues.push(cue(start, end));
      pos = end + 100 + Math.floor(rand() * 120);
    }
    const tol = [0, 20, 40, 60][seed % 4];
    const pts = [];
    cues.forEach(c => { pts.push(c.start); pts.push(c.end); });
    const cands = pts.map(t => {
      const out = [];
      for (let k = Math.floor(t / frameMs) - 3; k <= Math.ceil(t / frameMs) + 3; k++) {
        if (Math.abs(edge(k) - t) <= tol) out.push(k);
      }
      return out;
    });
    // 全枚举：按帧下标向量字典序从小到大递归，记录第一个（最早的）最优解
    let best = null;
    const chosen = new Array(pts.length);
    (function search(p) {
      if (p === pts.length) {
        let cost = 0;
        for (let q = 0; q < pts.length; q++) cost += Math.abs(edge(chosen[q]) - pts[q]);
        if (best == null || cost < best.cost) best = { cost, frames: chosen.slice() };
        return;
      }
      for (const k of cands[p]) {
        if (edge(k) < 0) continue;
        if (p > 0 && edge(k) - edge(chosen[p - 1]) < (p % 2 === 0 ? 100 : 500)) continue;
        chosen[p] = k;
        search(p + 1);
      }
    })(0);
    const plan = E.planFrameAlign(cues, '25', tol);
    if (best == null) {
      assert.equal(plan.ok, false, 'seed=' + seed + ' 应判定不可行');
    } else {
      assert.equal(plan.ok, true, 'seed=' + seed + ' 应可行');
      const got = [];
      for (const ch of plan.changes) got.push(ch.start, ch.end);
      const want = best.frames.map(edge);
      assert.equal(plan.totalDeltaMs, best.cost, 'seed=' + seed + ' 总偏移应为 ' + best.cost);
      assert.deepEqual(got, want, 'seed=' + seed + ' 方案应与全枚举（同分较早）一致');
    }
  }
});
