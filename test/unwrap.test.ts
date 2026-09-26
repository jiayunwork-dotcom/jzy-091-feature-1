/**
 * 连续相位序列整周期解算测试。
 *
 * 两块逻辑必须独立锁住：
 *   1. 整周期偏移的枚举与判定（每点补几圈、展开后相邻角速度变化幅度）；
 *   2. 缓变约束不满足时明确指出具体哪个采样点出问题（不硬选最近补偿）。
 *
 * 关键边界：
 *   - 小角速度退化：与现有单点反演逐点完全一致，cycleOffset 全为 0；
 *   - 人为卷绕后的往返还原：线性爬升 / 正弦摆动构造的真实相位历程按
 *     2π 主值截断后，必须被解回最初假设的角速度轨迹（即使很多单点已超 π）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wrapToPrincipal } from '../src/ambiguity.js';
import { omegaFromPhase, sagnacPhase } from '../src/sagnac.js';
import { UnwrapConstraintError, unwrapPhaseSeries } from '../src/unwrap.js';
import { ValidationError } from '../src/validation.js';

const g = { radius: 0.05, turns: 640, wavelength: 1.55e-6 };
const dt = 0.05;

/** 由假设的角速度轨迹构造仪器实际吐出的卷绕读数序列 */
function wrappedSeries(omegas: number[]): { truePhases: number[]; raw: number[] } {
  const truePhases = omegas.map((w) => sagnacPhase(g, w));
  return { truePhases, raw: truePhases.map(wrapToPrincipal) };
}

test('长度为 1 的序列退化为单点反调用，不跑整周期逻辑', () => {
  const phase = 1.234e-4;
  const r = unwrapPhaseSeries(g, [phase], { samplingInterval: dt });
  assert.equal(r.count, 1);
  assert.equal(r.samples[0].cycleOffset, 0);
  assert.equal(r.samples[0].cycleStep, null);
  assert.equal(r.samples[0].unwrappedPhase, phase);
  assert.ok(Math.abs(r.samples[0].omegaHat - omegaFromPhase(g, phase)) < 1e-300);
});

test('小角速度退化：全程远离半个模糊周期时，与单点反演逐点完全一致且不补任何整圈', () => {
  // 峰值相位 K·Ωmax ≈ 0.272×1e-4 ≈ 2.7e-5 rad，离 π 极远
  const n = 40;
  const omegas = Array.from({ length: n }, (_, i) => 1e-4 * Math.sin((2 * Math.PI * i) / n));
  const { raw } = wrappedSeries(omegas);

  const r = unwrapPhaseSeries(g, raw, { samplingInterval: dt });

  r.samples.forEach((s, i) => {
    assert.equal(s.cycleOffset, 0, `第 ${i} 点不应被补任何整周期`);
    assert.equal(s.unwrappedPhase, raw[i], '退化情形展开相位必须等于原始读数');
    const singlePoint = omegaFromPhase(g, raw[i]);
    assert.ok(
      Math.abs(s.omegaHat - singlePoint) <= Math.abs(singlePoint) * 1e-14,
      `第 ${i} 点角速度必须与单点反演一致`,
    );
  });
});

test('线性爬升往返还原：卷绕序列中大量单点已超 π，仍解回原始轨迹且补圈数可审查', () => {
  const n = 60;
  const omegas = Array.from({ length: n }, (_, i) => 50 * (i / (n - 1))); // 0 → 50 rad/s
  const { truePhases, raw } = wrappedSeries(omegas);

  // 构造出的输入里必须确实存在单独看已超过模糊阈值的点
  assert.ok(raw.filter((p) => Math.abs(p) > Math.PI * 0.9).length > 0, '测试前提：应含卷绕近边界点');
  assert.ok(raw.some((p, i) => Math.abs(p - truePhases[i]) > Math.PI), '测试前提：应发生截断');

  const r = unwrapPhaseSeries(g, raw, { samplingInterval: dt });
  assert.equal(r.count, n);

  let nonzeroSteps = 0;
  r.samples.forEach((s, i) => {
    // 展开相位必须严格还原假设的真实相位历程
    assert.ok(Math.abs(s.unwrappedPhase - truePhases[i]) < 1e-9, `点 ${i} 展开相位不符`);
    assert.ok(Math.abs(s.omegaHat - omegas[i]) < 1e-8, `点 ${i} 角速度轨迹不符`);
    // 恒等式：unwrapped = raw + 2π·cycleOffset
    assert.ok(Math.abs(s.unwrappedPhase - (s.rawPhase + 2 * Math.PI * s.cycleOffset)) < 1e-12);
    if (s.cycleStep !== null && s.cycleStep !== 0) nonzeroSteps++;
    if (i > 0) {
      // 审查字段：补偏移后前后两点角速度变化幅度
      assert.ok(Math.abs(s.deltaOmega! - (s.omegaHat - r.samples[i - 1].omegaHat)) < 1e-20);
      assert.ok(Math.abs(s.phaseStep!) <= Math.PI + 1e-12);
      assert.equal(s.time, i * dt);
    }
  });
  assert.ok(nonzeroSteps > 0, '爬升过程中必须实际发生过整周期补偿');
});

test('正弦摆动往返还原：正负方向反复卷绕，整周期偏移有正有负', () => {
  const n = 80; // 4 s × dt=0.05，f=0.25 Hz 正好一个周期
  const omegas = Array.from({ length: n }, (_, i) =>
    40 * Math.sin(2 * Math.PI * 0.25 * i * dt),
  );
  const { truePhases, raw } = wrappedSeries(omegas);
  assert.ok(raw.some((p) => Math.abs(p) > 0.9 * Math.PI), '测试前提：摆动峰值相位远超 π 被截断');

  const r = unwrapPhaseSeries(g, raw, { samplingInterval: dt });
  r.samples.forEach((s, i) => {
    assert.ok(Math.abs(s.unwrappedPhase - truePhases[i]) < 1e-9, `点 ${i} 展开相位不符`);
    assert.ok(Math.abs(s.omegaHat - omegas[i]) < 1e-8, `点 ${i} 角速度轨迹不符`);
  });

  const offsets = r.samples.map((s) => s.cycleOffset);
  assert.ok(offsets.some((o) => o > 0), '正半周应出现正整周期偏移');
  assert.ok(offsets.some((o) => o < 0), '负半周应出现负整周期偏移');
  // 回到起点附近时累计偏移应回到 0
  assert.equal(offsets[n - 1], 0);
});

test('缓变约束收紧后无法满足：明确报第一个越界采样点，且不输出轨迹', () => {
  // 相邻真实步长 0.6π，主值下 k=0 得 0.6π、k=-1 得 -1.4π，均超 0.5π
  const phases = [0, wrapToPrincipal(0.6 * Math.PI)];
  try {
    unwrapPhaseSeries(g, phases, { samplingInterval: dt, maxPhaseStep: 0.5 * Math.PI });
    assert.fail('应当抛出缓变约束错误');
  } catch (e) {
    assert.ok(e instanceof UnwrapConstraintError);
    assert.equal(e.index, 1);
    assert.equal(e.kind, 'no_valid_cycle');
    assert.match(e.message, /采样点 1/);
    // 枚举过程必须可审查
    assert.ok(e.candidates.length >= 3);
    assert.ok(e.candidates.every((c) => c.absPhaseStep > 0.5 * Math.PI - 1e-12));
    const json = e.toJSON();
    assert.equal(json.error, 'unwrap_constraint_violation');
    assert.equal(json.field, 'phases[1]');
  }
});

test('序列前几步合法、后续才突变：错误定位到真正出问题的那一步（index=3）', () => {
  const phases = [0, 0.1 * Math.PI, 0.2 * Math.PI, wrapToPrincipal(1.0 * Math.PI)];
  // 第 3 步：raw 由 0.2π 跳到主值 π（真实意图步长 0.8π），B=0.5π 下无可行补偿
  try {
    unwrapPhaseSeries(g, phases, { samplingInterval: dt, maxPhaseStep: 0.5 * Math.PI });
    assert.fail('应当抛出缓变约束错误');
  } catch (e) {
    assert.ok(e instanceof UnwrapConstraintError);
    assert.equal(e.index, 3);
    assert.equal(e.kind, 'no_valid_cycle');
  }
});

test('步长恰好压在 ±π 边界：两个整周期补偿同样可行，按不可判定拒绝而非偷偷选一个', () => {
  // [0, π]：k=0 → ΔΦ=π，k=-1 → ΔΦ=-π，B=π 下两者都可行
  try {
    unwrapPhaseSeries(g, [0, Math.PI], { samplingInterval: dt });
    assert.fail('应当抛出边界不可判定错误');
  } catch (e) {
    assert.ok(e instanceof UnwrapConstraintError);
    assert.equal(e.index, 1);
    assert.equal(e.kind, 'boundary_tie');
    assert.equal(e.candidates.length, 2);
    assert.ok(Math.abs(e.candidates[0].absPhaseStep - Math.PI) < 1e-9);
    assert.ok(Math.abs(e.candidates[1].absPhaseStep - Math.PI) < 1e-9);
  }
});

test('采样间隔非正数、空序列、读数非有限值：均按校验风格带原因拒绝', () => {
  assert.throws(
    () => unwrapPhaseSeries(g, [0, 0.1], { samplingInterval: 0 }),
    (e: unknown) => e instanceof ValidationError && /大于 0/.test((e as ValidationError).reason),
  );
  assert.throws(() => unwrapPhaseSeries(g, [0, 0.1], { samplingInterval: -0.05 }), ValidationError);
  assert.throws(
    () => unwrapPhaseSeries(g, [0, Number.NaN], { samplingInterval: dt }),
    (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === 'phases[1]',
  );
  assert.throws(
    () => unwrapPhaseSeries(g, [0, Number.POSITIVE_INFINITY], { samplingInterval: dt }),
    ValidationError,
  );
  assert.throws(() => unwrapPhaseSeries(g, [], { samplingInterval: dt }), ValidationError);
  assert.throws(
    () => unwrapPhaseSeries(g, [0, 0.1], { samplingInterval: dt, maxPhaseStep: 1.5 * Math.PI }),
    ValidationError,
  );
});

test('元数据：maxOmegaStep = B/K，采样间隔与首点参考说明随结果返回', () => {
  const r = unwrapPhaseSeries(g, [0, 0.01, 0.02], {
    samplingInterval: dt,
    maxPhaseStep: 0.5 * Math.PI,
  });
  assert.equal(r.samplingInterval, dt);
  assert.ok(Math.abs(r.maxOmegaStep - (0.5 * Math.PI) / r.scaleFactor) < 1e-20);
  assert.equal(r.anchor.cycleOffset, 0);
  assert.match(r.anchor.note, /参考点/);
});
