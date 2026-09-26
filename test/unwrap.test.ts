/**
 * 序列整周期解算测试，独立锁住四块内容：
 *   1) 整周期偏移的枚举与判定逻辑（resolveCycleOffset 单元级）；
 *   2) 小角速度退化情形：序列解算必须与现有单点反演逐点数值一致；
 *   3) 人为卷绕往返：已知角速度轨迹 → 正算相位 → 2π 主值卷绕 → 解算还原；
 *   4) 缓变约束被破坏时必须指明具体采样点下标，绝不强行选最近补偿掩盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { wrapToPrincipal } from '../src/ambiguity.js';
import { omegaFromPhase, sagnacPhase } from '../src/sagnac.js';
import { scaleFactor } from '../src/geometry.js';
import { AMBIGUITY_THRESHOLD } from '../src/config.js';
import { ValidationError } from '../src/validation.js';
import {
  AMBIGUITY_PERIOD,
  DEFAULT_MAX_PHASE_STEP,
  resolveCycleOffset,
  unwrapPhaseSequence,
} from '../src/unwrap.js';

const g = { radius: 0.05, turns: 640, wavelength: 1.55e-6 };
const K = scaleFactor(g);
const DT = 0.02;

const app = buildServer();

/* ---------- 1) 整周期偏移的枚举与判定 ---------- */

test('无需补偿的缓变步进：偏移 0', () => {
  const d = resolveCycleOffset(0.5, 0.8, Math.PI);
  assert.equal(d.offset, 0);
  assert.ok(Math.abs(d.phaseStep - 0.3) < 1e-15);
});

test('正向跨越卷绕边界：补 +1 圈', () => {
  // 真实相位 3.0 → 3.2，读数被卷绕为 3.2 − 2π ≈ −3.083
  const reading = 3.2 - AMBIGUITY_PERIOD;
  const d = resolveCycleOffset(3.0, reading, Math.PI);
  assert.equal(d.offset, 1);
  assert.ok(Math.abs(d.phaseStep - 0.2) < 1e-15);
});

test('负向跨越卷绕边界：补 −1 圈', () => {
  // 真实相位 −3.0 → −3.2，读数被卷绕为 −3.2 + 2π ≈ 3.083
  const reading = -3.2 + AMBIGUITY_PERIOD;
  const d = resolveCycleOffset(-3.0, reading, Math.PI);
  assert.equal(d.offset, -1);
  assert.ok(Math.abs(d.phaseStep + 0.2) < 1e-15);
});

test('已解缠到多圈之后仍能正确续接', () => {
  // 上一点已展开到 7.0（约 1.1 圈），读数 1.0 对应真实相位 1.0 + 2π
  const d = resolveCycleOffset(7.0, 1.0, Math.PI);
  assert.equal(d.offset, 1);
  assert.ok(Math.abs(d.phaseStep - (1.0 + AMBIGUITY_PERIOD - 7.0)) < 1e-15);
});

test('收紧的缓变窗口内恰有一个可行补偿', () => {
  const d = resolveCycleOffset(0, 0.4 * Math.PI, 0.5 * Math.PI);
  assert.equal(d.offset, 0);
  assert.ok(Math.abs(d.phaseStep - 0.4 * Math.PI) < 1e-15);
});

test('任何整周期补偿都落不进缓变窗口 → 抛错并指明采样点下标', () => {
  // 读数 0.9π：k=0 需 |Δφ| = 0.9π，k=−1 需 1.1π，均超过 0.5π 窗口
  assert.throws(
    () => resolveCycleOffset(0, 0.9 * Math.PI, 0.5 * Math.PI, 3),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.field, 'phases[3]');
      assert.match(e.reason, /第 3 个采样点/);
      assert.match(e.reason, /剧烈突变|缺口/);
      assert.match(e.reason, /不会强行选取/);
      return true;
    },
  );
});

test('跳变恰好 ±π 时两个补偿同时可行 → 拒绝猜测', () => {
  assert.throws(
    () => resolveCycleOffset(0, Math.PI, DEFAULT_MAX_PHASE_STEP, 1),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.field, 'phases[1]');
      assert.match(e.reason, /不唯一/);
      return true;
    },
  );
});

test('maxPhaseStep 超过 π 直接拒绝（破坏唯一性前提）', () => {
  assert.throws(() => resolveCycleOffset(0, 0.1, 4), ValidationError);
  assert.throws(() => resolveCycleOffset(0, 0.1, 0), ValidationError);
  assert.throws(() => resolveCycleOffset(0, 0.1, Number.NaN), ValidationError);
});

/* ---------- 2) 小角速度退化：与单点反演逐点一致 ---------- */

test('退化情形：全程未接近模糊阈值时与单点反演逐点数值一致', () => {
  // 相位全部在微弧度量级，远未接近 0.9π 模糊阈值
  const omegas = [0, 1e-4, 2.5e-4, 1e-4, -5e-5, -2e-4, 0];
  const phases = omegas.map((w) => sagnacPhase(g, w));
  const result = unwrapPhaseSequence(g, DT, phases);

  assert.equal(result.count, omegas.length);
  result.samples.forEach((s, i) => {
    assert.ok(Math.abs(phases[i]) < AMBIGUITY_THRESHOLD, '前提：读数从未接近模糊阈值');
    assert.equal(s.cycleOffset, 0, `第 ${i} 点不应被补任何整周期`);
    assert.equal(s.unwrappedPhase, phases[i], '解缠相位必须与原始读数完全一致');
    // 与现有单点反演同一函数、同一输入：逐位相等
    assert.equal(s.omega, omegaFromPhase(g, phases[i]));
    assert.ok(Math.abs(s.omega - omegas[i]) < 1e-15);
    assert.equal(s.time, i * DT);
  });

  // 每一步的角速度变化幅度可审计
  assert.equal(result.steps.length, omegas.length - 1);
  result.steps.forEach((st, j) => {
    assert.equal(st.index, j + 1);
    assert.ok(Math.abs(st.phaseStep - (phases[j + 1] - phases[j])) < 1e-20);
    assert.ok(Math.abs(st.omegaStep - (phases[j + 1] - phases[j]) / K) < 1e-20);
  });
});

test('长度为一的序列退化为单点反演，不启用整周期解算', () => {
  const phase = 2e-5;
  const result = unwrapPhaseSequence(g, DT, [phase]);
  assert.equal(result.count, 1);
  assert.equal(result.samples[0].cycleOffset, 0);
  assert.equal(result.samples[0].unwrappedPhase, phase);
  assert.equal(result.samples[0].omega, omegaFromPhase(g, phase));
  assert.equal(result.steps.length, 0);
});

/* ---------- 3) 人为卷绕后的往返还原 ---------- */

test('往返：线性爬升轨迹经人为卷绕后被完整还原', () => {
  const count = 200;
  // Ω 从 0 线性爬到 60 rad/s：总相位 ≈ 16.3 rad，多次越过 2π；
  // 每步 ΔΩ ≈ 0.302 rad/s ⇒ Δφ ≈ 0.082 rad ≪ π，满足缓变假设
  const omegas = Array.from({ length: count }, (_, i) => (60 * i) / (count - 1));
  const truePhases = omegas.map((w) => sagnacPhase(g, w));
  const wrapped = truePhases.map((p) => wrapToPrincipal(p));

  // 构造出的原始读数里必须有大量点单独看已超过模糊阈值
  const overThreshold = wrapped.filter((p) => Math.abs(p) >= AMBIGUITY_THRESHOLD).length;
  assert.ok(overThreshold >= 10, `应有大量读数超过模糊阈值，实际 ${overThreshold}`);

  const result = unwrapPhaseSequence(g, DT, wrapped);
  assert.equal(result.count, count);
  // 总相位多次越过 2π，整周期解算必须真的补过圈
  assert.ok(Math.max(...result.samples.map((s) => s.cycleOffset)) >= 2);

  result.samples.forEach((s, i) => {
    assert.ok(
      Math.abs(s.omega - omegas[i]) < 1e-9,
      `第 ${i} 点还原偏差过大：${s.omega} vs ${omegas[i]}`,
    );
    assert.ok(Math.abs(s.unwrappedPhase - truePhases[i]) < 1e-9);
  });
  // 每一步的相位变化都在缓变窗口内且可审计
  result.steps.forEach((st) => {
    assert.ok(Math.abs(st.phaseStep) <= DEFAULT_MAX_PHASE_STEP + 1e-12);
  });
});

test('往返：正弦摆动轨迹（正反向均穿越卷绕边界）被完整还原', () => {
  const count = 201;
  // Ω(t) = 20·sin(2π·0.5·t)：峰值相位 K·20 ≈ 5.44 rad，两个方向都越过卷绕边界；
  // 最大每步 |ΔΩ| ≈ 20·2π·0.5·0.02 ≈ 1.257 rad/s ⇒ |Δφ| ≈ 0.34 rad < π
  const omegas = Array.from({ length: count }, (_, i) =>
    20 * Math.sin(2 * Math.PI * 0.5 * i * DT),
  );
  const truePhases = omegas.map((w) => sagnacPhase(g, w));
  const wrapped = truePhases.map((p) => wrapToPrincipal(p));

  const result = unwrapPhaseSequence(g, DT, wrapped);
  result.samples.forEach((s, i) => {
    assert.ok(
      Math.abs(s.omega - omegas[i]) < 1e-9,
      `第 ${i} 点还原偏差过大：${s.omega} vs ${omegas[i]}`,
    );
  });
  // 正负两个方向都补过圈
  const offsets = result.samples.map((s) => s.cycleOffset);
  assert.ok(Math.max(...offsets) >= 1);
  assert.ok(Math.min(...offsets) <= -1);
});

/* ---------- 4) 缓变违约必须指明具体采样点 ---------- */

test('序列中段出现无法补偿的跳变：错误指明具体采样点，不强行选最近补偿', () => {
  // 前三个点缓变；第 3 点（下标 3）真实相位跳变 0.9π，窗口收紧到 0.5π
  const phases = [0, 0.2, 0.4, wrapToPrincipal(0.4 + 0.9 * Math.PI)];
  assert.throws(
    () => unwrapPhaseSequence(g, DT, phases, 0.5 * Math.PI),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.field, 'phases[3]');
      assert.match(e.reason, /第 3 个采样点/);
      return true;
    },
  );
});

test('物理局限如实呈现：默认 π 窗口下 0.9π 跳变有可行补偿（收紧窗口才可检测）', () => {
  // 同一段序列在默认窗口下 |Δφ| = 0.9π < π 可行——相邻两点本身不含
  // 识别超 π 违约的信息，这是解缠的物理固有限制，模块注释已声明
  const phases = [0, 0.2, 0.4, wrapToPrincipal(0.4 + 0.9 * Math.PI)];
  assert.doesNotThrow(() => unwrapPhaseSequence(g, DT, phases));
});

/* ---------- 输入校验 ---------- */

test('采样间隔必须为正数', () => {
  assert.throws(() => unwrapPhaseSequence(g, 0, [0, 0.1]), ValidationError);
  assert.throws(() => unwrapPhaseSequence(g, -0.02, [0, 0.1]), ValidationError);
  assert.throws(() => unwrapPhaseSequence(g, Number.NaN, [0, 0.1]), ValidationError);
});

test('序列不能为空、读数必须逐点有限', () => {
  assert.throws(() => unwrapPhaseSequence(g, DT, []), ValidationError);
  assert.throws(
    () => unwrapPhaseSequence(g, DT, [0, Number.NaN, 0.2]),
    (e: unknown) => e instanceof ValidationError && e.field === 'phases[1]',
  );
  assert.throws(
    () => unwrapPhaseSequence(g, DT, [0, Number.POSITIVE_INFINITY]),
    (e: unknown) => e instanceof ValidationError && e.field === 'phases[1]',
  );
});

test('maxPhaseStep 必须 ∈ (0, π]', () => {
  assert.throws(() => unwrapPhaseSequence(g, DT, [0, 0.1], 0), ValidationError);
  assert.throws(() => unwrapPhaseSequence(g, DT, [0, 0.1], -1), ValidationError);
  assert.throws(() => unwrapPhaseSequence(g, DT, [0, 0.1], 4), ValidationError);
  assert.doesNotThrow(() => unwrapPhaseSequence(g, DT, [0, 0.1], Math.PI));
});

/* ---------- HTTP 端到端 ---------- */

test('POST /unwrap 端到端：卷绕序列还原角速度轨迹', async () => {
  const omegas = Array.from({ length: 50 }, (_, i) => (12 * i) / 49);
  const wrapped = omegas.map((w) => wrapToPrincipal(sagnacPhase(g, w)));
  const res = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: DT, phases: wrapped },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 50);
  assert.equal(body.sampleInterval, DT);
  assert.equal(body.maxPhaseStep, Math.PI);
  assert.equal(body.steps.length, 49);
  body.samples.forEach((s: { omega: number; time: number; cycleOffset: number }, i: number) => {
    assert.ok(Math.abs(s.omega - omegas[i]) < 1e-9);
    assert.equal(s.time, i * DT);
  });
  // 末段相位越过 2π，必须真的补过圈
  assert.ok(Math.max(...body.samples.map((s: { cycleOffset: number }) => s.cycleOffset)) >= 1);
});

test('POST /unwrap 退化情形与 /calibrate 单点反演逐点一致', async () => {
  const phases = [1e-5, 2e-5, -1.5e-5, 0, 3e-5];
  const res = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: DT, phases },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  for (let i = 0; i < phases.length; i++) {
    const cal = await app.inject({
      method: 'POST',
      url: '/calibrate',
      payload: { geometry: g, phase: phases[i] },
    });
    assert.equal(
      body.samples[i].omega,
      cal.json().omegaHat,
      `第 ${i} 点必须与现有单点反演数值一致`,
    );
    assert.equal(body.samples[i].cycleOffset, 0);
  }
});

test('POST /unwrap 校验失败与缓变违约均返回带原因的 400', async () => {
  const badDt = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: 0, phases: [0, 0.1] },
  });
  assert.equal(badDt.statusCode, 400);
  assert.equal(badDt.json().field, 'sampleInterval');

  const empty = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: DT, phases: [] },
  });
  assert.equal(empty.statusCode, 400);

  const badReading = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: DT, phases: [0, 'x'] },
  });
  assert.equal(badReading.statusCode, 400);
  assert.equal(badReading.json().field, 'phases[1]');

  const badWindow = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry: g, sampleInterval: DT, phases: [0, 0.1], maxPhaseStep: 4 },
  });
  assert.equal(badWindow.statusCode, 400);
  assert.equal(badWindow.json().field, 'maxPhaseStep');

  // 缓变违约：错误 JSON 必须指出具体是哪一个采样点
  const violation = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: {
      geometry: g,
      sampleInterval: DT,
      phases: [0, 0.2, 0.4, wrapToPrincipal(0.4 + 0.9 * Math.PI)],
      maxPhaseStep: 0.5 * Math.PI,
    },
  });
  assert.equal(violation.statusCode, 400);
  const body = violation.json();
  assert.equal(body.error, 'invalid_request');
  assert.equal(body.field, 'phases[3]');
  assert.match(body.reason, /第 3 个采样点/);
});
