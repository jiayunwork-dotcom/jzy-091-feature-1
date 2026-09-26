/**
 * 序列整周期解算模块（独立职责）——连续相位序列的 2π 解缠与角速度轨迹反演。
 *
 * 物理背景：开环干涉强度只对 Δφ mod 2π 敏感，解调电路按固定采样间隔
 * 吐出的原始读数被卷绕在 (-π, π] 主值区间内。孤立地看某一个点，只要
 * 它接近半个周期，就无法分辨“没转多少”与“转了一整圈又多一点”——
 * 单点模糊告警止步于此。但角速度缓变（一个采样周期内跳变不超过半个
 * 模糊周期，即 |Δφ| ≤ π）时，相邻点之间的差异给出了单点永远给不出的
 * 约束：读数 r_i 的真实相位必为 r_i + 2πk，枚举整数 k 后至多一个能让
 * 相邻相位差落入缓变窗口（窗口宽 2·maxPhaseStep ≤ 2π，保证唯一性）。
 *
 * 本模块只做这一件事：逐点确定整周期偏移、把序列展开成连续相位历程、
 * 按标度因数反演角速度时间轨迹。标度因数与单点反演复用 geometry /
 * sagnac 中已验证的实现，不与正算、扫描、闭环链路互相纠缠。
 *
 * 已知局限（物理固有，而非实现缺陷）：若真实角速度在一个采样间隔内的
 * 相位跳变超过 π，任何解缠都会静默选错整周期数——相邻两个采样点本身
 * 不包含识别这种违约的信息。要可检测地暴露剧烈突变 / 数据缺口，应把
 * maxPhaseStep 收紧到台架实测的缓变上限（< π）：此时所有整周期补偿都
 * 落不进窗口的步骤会以指明采样点下标的错误显式失败，绝不强行选取
 * 最接近的补偿量来掩盖数据矛盾。
 */
import { fiberLength, scaleFactor } from './geometry.js';
import { omegaFromPhase } from './sagnac.js';
import type { CoilGeometry, UnwrappedSample, UnwrapResult, UnwrapStep } from './types.js';
import {
  ValidationError,
  validateGeometry,
  validateMaxPhaseStep,
  validatePhaseSequence,
  validateSampleInterval,
} from './validation.js';

/** 模糊周期：开环干涉相位的周期 2π，单位 rad */
export const AMBIGUITY_PERIOD = 2 * Math.PI;

/** 默认缓变约束：相邻点相位变化不超过半个模糊周期 π（rad） */
export const DEFAULT_MAX_PHASE_STEP = Math.PI;

/** 单点整周期补偿的判定结果 */
export interface CycleOffsetDecision {
  /** 采纳的整周期数 k（真实相位 = 读数 + 2πk） */
  offset: number;
  /** 采纳后相对上一已解缠点的相位步进 Δφ，rad */
  phaseStep: number;
}

/**
 * 为一个采样点枚举所有可能的整周期补偿并作出唯一判定。
 *
 * 读数 r 对应的真实相位候选为 r + 2πk（k ∈ ℤ），缓变约束要求
 * |r + 2πk − φ_prev| ≤ maxPhaseStep。候选之间恰好相差 2π，而窗口宽
 * 2·maxPhaseStep ≤ 2π，因此只可能出现三种情形：
 *   - 恰好一个可行 k → 采纳；
 *   - 零个可行 k（仅当 maxPhaseStep < π 时可能）→ 抛 ValidationError，
 *     指明采样点下标与最接近可达的跳变，绝不强行选最近补偿；
 *   - 两个可行 k（仅当跳变恰好落在 ±π 决策边界上）→ 同样抛错拒绝猜测。
 *
 * @param prevUnwrappedPhase 上一个采样点已解缠的连续相位，rad
 * @param reading            当前采样点的原始（卷绕）读数，rad
 * @param maxPhaseStep       缓变窗口半宽，rad，必须 ∈ (0, π]
 * @param index              可选，采样点下标，仅用于错误信息定位
 */
export function resolveCycleOffset(
  prevUnwrappedPhase: number,
  reading: number,
  maxPhaseStep: number = DEFAULT_MAX_PHASE_STEP,
  index?: number,
): CycleOffsetDecision {
  const maxStep = validateMaxPhaseStep(maxPhaseStep);
  const field = index === undefined ? undefined : `phases[${index}]`;
  const at = index === undefined ? '该采样点' : `第 ${index} 个采样点（下标从 0 计）`;

  // 可行性比较的浮点保护：随相位量级缩放的微小裕量，只吸收舍入噪声，
  // 绝不可能把宏观的缓变违约（如 0.9π 对 0.5π 窗口）误判为可行
  const scale = Math.max(Math.abs(prevUnwrappedPhase), Math.abs(reading), maxStep, 1);
  const eps = 8 * Number.EPSILON * scale;

  // 只需考察最接近的三个候选：相邻候选的步进恰好差 2π，更远的候选
  // |Δφ| 只会更大，不可能落入宽度 ≤ 2π 的缓变窗口。
  // Math.round 对 (-0.5, 0) 会给出 -0：整周期数 -0 与 0 物理等价，
  // 统一归一为 +0，避免审计输出出现“补了负零圈”的无意义形态
  const nearest = Math.round((prevUnwrappedPhase - reading) / AMBIGUITY_PERIOD);
  const candidates: CycleOffsetDecision[] = [nearest - 1, nearest, nearest + 1].map((k) => ({
    offset: k === 0 ? 0 : k,
    phaseStep: reading + AMBIGUITY_PERIOD * k - prevUnwrappedPhase,
  }));
  const feasible = candidates.filter((c) => Math.abs(c.phaseStep) <= maxStep + eps);

  if (feasible.length === 1) {
    return feasible[0];
  }

  if (feasible.length === 0) {
    const best = candidates.reduce((a, b) =>
      Math.abs(a.phaseStep) <= Math.abs(b.phaseStep) ? a : b,
    );
    throw new ValidationError(
      `${at}无法确定整周期补偿：读数 ${reading} 相对上一点（已解缠相位 ${prevUnwrappedPhase}）` +
        `的所有整周期补偿都落在缓变窗口外——最接近的补偿 k=${best.offset} 仍需 ` +
        `|Δφ| = ${Math.abs(best.phaseStep)} rad，超过允许的最大步长 ${maxStep} rad。` +
        `这通常意味着采样点之间转速发生了剧烈突变或数据存在缺口，` +
        `服务不会强行选取最接近的补偿量来掩盖矛盾。`,
      field,
    );
  }

  // 两个候选同时可行，只可能发生在跳变恰好 ±π 的决策边界上
  throw new ValidationError(
    `${at}的整周期补偿不唯一：读数 ${reading} 相对上一点（已解缠相位 ${prevUnwrappedPhase}）` +
      `的相位跳变恰好落在 ±半周期决策边界上，补偿 k=${feasible[0].offset} 与 ` +
      `k=${feasible[1].offset} 均满足缓变约束（|Δφ| ≤ ${maxStep} rad），` +
      `无法唯一判定，拒绝猜测。`,
    field,
  );
}

/**
 * 把一段按固定采样间隔测得的卷绕相位序列解缠成连续相位历程，
 * 并反演为角速度时间轨迹。
 *
 * 第 0 个点为参考点，整周期偏移定义为 0；长度为一的序列因此直接
 * 退化为对现有单点反演的调用，不启用整周期解算。若整段序列的相邻
 * 相位差从未接近半个模糊周期，所有点的偏移量都是 0，结果与逐点
 * 单点反演在数值上完全一致。
 *
 * @param geometry       线圈几何
 * @param sampleInterval 采样间隔 dt（必须为正数），s
 * @param phases         按时间顺序排列的原始（卷绕）相位读数，rad
 * @param maxPhaseStep   缓变约束：相邻点允许的最大相位变化，rad；
 *                       默认 π（半个模糊周期），必须 ∈ (0, π]
 */
export function unwrapPhaseSequence(
  geometry: CoilGeometry,
  sampleInterval: number,
  phases: number[],
  maxPhaseStep: number = DEFAULT_MAX_PHASE_STEP,
): UnwrapResult {
  const g = validateGeometry(geometry);
  const dt = validateSampleInterval(sampleInterval);
  const readings = validatePhaseSequence(phases);
  const maxStep = validateMaxPhaseStep(maxPhaseStep);
  const K = scaleFactor(g);

  const samples: UnwrappedSample[] = [];
  const steps: UnwrapStep[] = [];

  // 参考点（第 0 点）：偏移量定义为 0，直接走现有单点反演
  let prevUnwrapped = readings[0];
  samples.push({
    index: 0,
    time: 0,
    measuredPhase: readings[0],
    cycleOffset: 0,
    unwrappedPhase: readings[0],
    omega: omegaFromPhase(g, readings[0]),
  });

  for (let i = 1; i < readings.length; i++) {
    const { offset, phaseStep } = resolveCycleOffset(prevUnwrapped, readings[i], maxStep, i);
    const unwrapped = readings[i] + AMBIGUITY_PERIOD * offset;
    samples.push({
      index: i,
      time: i * dt,
      measuredPhase: readings[i],
      cycleOffset: offset,
      unwrappedPhase: unwrapped,
      omega: omegaFromPhase(g, unwrapped),
    });
    steps.push({
      index: i,
      phaseStep,
      omegaStep: phaseStep / K,
    });
    prevUnwrapped = unwrapped;
  }

  return {
    geometry: g,
    fiberLength: fiberLength(g),
    scaleFactor: K,
    sampleInterval: dt,
    maxPhaseStep: maxStep,
    count: samples.length,
    samples,
    steps,
  };
}
