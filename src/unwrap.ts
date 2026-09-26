/**
 * 连续相位序列整周期解算模块（独立处理链路）。
 *
 * 背景：开环干涉强度只对 Δφ mod 2π 敏感，仪器吐出的原始相位被卷绕在
 * 主值区间（典型为 (−π, π]）。单点测量在 |Δφ| 接近/超过 π 时无法判断
 * “没转多少”还是“转多了一整圈又多一点”，ambiguity 模块只能告警，
 * 给不出该补几圈。
 *
 * 本模块利用**连续序列**的额外信息：角速度缓变 ⇒ 一个采样间隔内真实
 * 相位步长 |ΔΦ_i| = |K·(Ω_i − Ω_{i−1})·…… | 不超过半个模糊周期。
 * 对每个采样点枚举相对上一点的整周期补偿量 k（= n_i − n_{i−1}），使展开后
 * 相位步长
 *
 *     ΔΦ_i = p_i − p_{i−1} + 2π·k = 2π·k − d，  d = p_{i−1} − p_i
 *
 * 落在缓变约束 |ΔΦ_i| ≤ B（B ≤ π）内。B ≤ π 时该可行 k 至多一个：
 *   - 没有可行 k      ⇒ 该步发生剧烈突变/数据缺口，显式报错，绝不硬选最近值；
 *   - 有两个可行 k    ⇒ 步长恰好压在 ±B 边界上，数据本身不可判定，同样报错；
 *   - 恰有一个可行 k  ⇒ 累计整周期偏移 n_i = n_{i−1} + k_i，序列被唯一展开。
 *
 * 参考点固定为序列首点（n_0 = 0）：相邻差异只能解开相对整周期歧义，
 * 整条轨迹共有的 2π 绝对偏移无法由本链路消除（物理上需要量程先验）。
 *
 * 本链路不重新发明标度因数与反演：展开后统一复用 omegaFromPhase（K 与
 * 单点 /calibrate 完全同源）。长度为 1 的序列直接退化为单点反演。
 */
import { UNWRAP_MAX_PHASE_STEP } from './config.js';
import { fiberLength, scaleFactor } from './geometry.js';
import { omegaFromPhase } from './sagnac.js';
import type { CoilGeometry, UnwrapResult, UnwrapSample } from './types.js';
import {
  validateGeometry,
  validateMaxPhaseStep,
  validatePhaseSeries,
  validateSamplingInterval,
} from './validation.js';

/** 浮点边界容差（rad）：判定 |步长| ≤ B 时吸收卷绕运算的舍入误差 */
const STEP_EPS = 1e-12;

/**
 * 缓变约束无法满足时抛出：明确指出是哪一步（采样点 index）出了问题，
 * 而不是强行选一个最接近的补偿量掩盖过去。HTTP 层映射为 422。
 */
export class UnwrapConstraintError extends Error {
  /** 第一个无法满足缓变约束的采样点序号（>=1） */
  readonly index: number;
  /** no_valid_cycle：所有整周期补偿都超限；boundary_tie：边界上两个补偿量同样可行 */
  readonly kind: 'no_valid_cycle' | 'boundary_tie';
  /** 允许的单步相位上限 B，rad */
  readonly maxPhaseStep: number;
  /** 展开到上一点时的相位 Φ_{i−1}，rad */
  readonly previousUnwrappedPhase: number;
  /** 出问题点的原始读数 p_i，rad */
  readonly rawPhase: number;
  /** 枚举过的整周期步长候选及各自补偿后的相位步长，供调用方审查 */
  readonly candidates: { cycleStep: number; phaseStep: number; absPhaseStep: number }[];

  constructor(init: {
    index: number;
    kind: 'no_valid_cycle' | 'boundary_tie';
    maxPhaseStep: number;
    previousUnwrappedPhase: number;
    rawPhase: number;
    candidates: { cycleStep: number; phaseStep: number; absPhaseStep: number }[];
  }) {
    const where = `采样点 ${init.index}（相对上一点）`;
    const tried = init.candidates
      .map((c) => `k=${c.cycleStep}→ΔΦ=${c.phaseStep.toExponential(6)} rad`)
      .join('，');
    const reason =
      init.kind === 'boundary_tie'
        ? `${where}的相位步长恰好压在缓变约束边界 ±${init.maxPhaseStep.toExponential(6)} rad 上，` +
          `存在两个同样可行的整周期补偿量（${tried}），数据本身无法判定该补哪一圈；` +
          `服务未强行选择补偿量。这通常意味着转速突变或采样数据存在缺口。`
        : `${where}无论补哪个整周期，展开后的相位步长都超过缓变上限 ` +
          `${init.maxPhaseStep.toExponential(6)} rad（枚举：${tried}）。` +
          `该采样间隔内转速发生了超出“每采样周期不超过半个模糊周期”假设的剧烈突变，或数据存在缺口；` +
          `服务未强行选取最接近的补偿量，整段轨迹不予输出。`;
    super(reason);
    this.name = 'UnwrapConstraintError';
    this.index = init.index;
    this.kind = init.kind;
    this.maxPhaseStep = init.maxPhaseStep;
    this.previousUnwrappedPhase = init.previousUnwrappedPhase;
    this.rawPhase = init.rawPhase;
    this.candidates = init.candidates;
  }

  /** 供 HTTP 层直接返回的错误 JSON */
  toJSON(): {
    error: 'unwrap_constraint_violation';
    field: string;
    reason: string;
    index: number;
    kind: 'no_valid_cycle' | 'boundary_tie';
    maxPhaseStep: number;
    previousUnwrappedPhase: number;
    rawPhase: number;
    candidates: { cycleStep: number; phaseStep: number; absPhaseStep: number }[];
  } {
    return {
      error: 'unwrap_constraint_violation',
      field: `phases[${this.index}]`,
      reason: this.message,
      index: this.index,
      kind: this.kind,
      maxPhaseStep: this.maxPhaseStep,
      previousUnwrappedPhase: this.previousUnwrappedPhase,
      rawPhase: this.rawPhase,
      candidates: this.candidates,
    };
  }
}

export interface UnwrapOptions {
  /** 固定采样间隔 dt，s（必须为正有限数） */
  samplingInterval: number;
  /** 单采样间隔允许的最大相位步长，rad；默认 π（半个模糊周期） */
  maxPhaseStep?: number;
}

/**
 * 把一段按时间顺序测得的卷绕相位序列展开成连续相位历程，并逐点反演角速度。
 *
 * @param geometry 线圈几何（与单点链路同源校验）
 * @param phases   原始（卷绕）相位读数，按时间顺序，长度 >= 1
 * @param options  采样间隔与缓变约束
 */
export function unwrapPhaseSeries(
  geometry: CoilGeometry,
  phases: number[],
  options: UnwrapOptions,
): UnwrapResult {
  validateGeometry(geometry);
  const p = validatePhaseSeries(phases);
  const dt = validateSamplingInterval(options.samplingInterval);
  const B =
    options.maxPhaseStep === undefined
      ? UNWRAP_MAX_PHASE_STEP
      : validateMaxPhaseStep(options.maxPhaseStep);

  const K = scaleFactor(geometry);

  // 参考点：首点不补整周期。长度为 1 时整个序列即此点，直接退化为单点反演。
  const samples: UnwrapSample[] = [];
  const phi0 = p[0];
  samples.push({
    index: 0,
    time: 0,
    rawPhase: phi0,
    cycleOffset: 0,
    cycleStep: null,
    unwrappedPhase: phi0,
    omegaHat: omegaFromPhase(geometry, phi0),
    phaseStep: null,
    deltaOmega: null,
  });

  let prevUnwrapped = phi0;
  let prevOffset = 0;

  for (let i = 1; i < p.length; i++) {
    // 标准 Itoh 邻域步长中心：d = p_{i−1} − p_i，ΔΦ = 2πk − d，
    // 把 −d 折回 (−π, π] 的那个 k 是最近邻候选；可行解若存在必在其附近。
    const d = p[i - 1] - p[i];
    const center = Math.round(d / (2 * Math.PI));

    const candidates = [-2, -1, 0, 1, 2].map((shift) => {
      const k = center + shift;
      const phaseStep = 2 * Math.PI * k - d; // ΔΦ_i = (p_i − p_{i−1}) + 2π·k = 2π·k − d
      return { cycleStep: k, phaseStep, absPhaseStep: Math.abs(phaseStep) };
    });

    const feasible = candidates.filter((c) => c.absPhaseStep <= B + STEP_EPS);

    if (feasible.length === 0) {
      throw new UnwrapConstraintError({
        index: i,
        kind: 'no_valid_cycle',
        maxPhaseStep: B,
        previousUnwrappedPhase: prevUnwrapped,
        rawPhase: p[i],
        candidates,
      });
    }
    if (feasible.length >= 2) {
      // 只可能发生在步长恰好压在 ±B 边界（B = π 时即 ±π）：两个整圈都讲得通，
      // 数据本身不可判定，明确报错而非偷偷选一个。
      throw new UnwrapConstraintError({
        index: i,
        kind: 'boundary_tie',
        maxPhaseStep: B,
        previousUnwrappedPhase: prevUnwrapped,
        rawPhase: p[i],
        candidates: feasible.sort((a, b) => a.absPhaseStep - b.absPhaseStep),
      });
    }

    const chosen = feasible[0];
    const offset = prevOffset + chosen.cycleStep;
    const unwrapped = p[i] + 2 * Math.PI * offset;
    const omegaHat = omegaFromPhase(geometry, unwrapped);

    samples.push({
      index: i,
      time: i * dt,
      rawPhase: p[i],
      cycleOffset: offset,
      cycleStep: chosen.cycleStep,
      unwrappedPhase: unwrapped,
      omegaHat,
      phaseStep: chosen.phaseStep,
      deltaOmega: omegaHat - samples[i - 1].omegaHat,
    });

    prevUnwrapped = unwrapped;
    prevOffset = offset;
  }

  return {
    geometry: { ...geometry },
    fiberLength: fiberLength(geometry),
    scaleFactor: K,
    samplingInterval: dt,
    count: p.length,
    maxPhaseStep: B,
    maxOmegaStep: B / K,
    anchor: {
      index: 0,
      cycleOffset: 0,
      note:
        '相邻相位差异只能解开相对整周期歧义；参考点（首点）固定 cycleOffset=0，' +
        '整条轨迹共有的 2π 绝对偏移需量程先验另行消除。',
    },
    samples,
  };
}
