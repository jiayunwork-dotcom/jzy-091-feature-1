/**
 * 输入校验模块（独立职责）。
 *
 * 几何铁律：半径 R、匝数 N、波长 λ 任一小于等于零，
 * 一律以“带原因的错误 JSON”拒绝（HTTP 层映射为 400）。
 * 角速度允许为任意有限实数（包括 0 和负值，反号对称依赖负输入）。
 */
import type { CoilGeometry, OmegaGrid } from './types.js';

/** 带原因、可序列化为 JSON 的请求校验错误 */
export class ValidationError extends Error {
  readonly reason: string;
  readonly field?: string;

  constructor(reason: string, field?: string) {
    super(field ? `${field}: ${reason}` : reason);
    this.name = 'ValidationError';
    this.reason = reason;
    this.field = field;
  }

  /** 供 HTTP 层直接返回的错误 JSON */
  toJSON(): { error: 'invalid_request'; field?: string; reason: string } {
    return {
      error: 'invalid_request',
      ...(this.field === undefined ? {} : { field: this.field }),
      reason: this.reason,
    };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验并归一化线圈几何。
 * 半径、匝数、波长必须为有限正数；匝数还必须是正整数（不存在“半匝”光纤）。
 */
export function validateGeometry(input: unknown): CoilGeometry {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('geometry 必须是包含 radius、turns、wavelength 的对象', 'geometry');
  }
  const g = input as Record<string, unknown>;

  if (!('radius' in g)) throw new ValidationError('缺少线圈环半径 radius', 'radius');
  if (!('turns' in g)) throw new ValidationError('缺少匝数 turns', 'turns');
  if (!('wavelength' in g)) throw new ValidationError('缺少真空波长 wavelength', 'wavelength');

  const { radius, turns, wavelength } = g;

  if (!isFiniteNumber(radius)) {
    throw new ValidationError('半径 radius 必须是有限数值', 'radius');
  }
  if (radius <= 0) {
    throw new ValidationError(
      `半径 radius 必须大于 0（收到 ${radius}）；半径为零或负时 Sagnac 相位没有物理意义`,
      'radius',
    );
  }

  if (!isFiniteNumber(turns)) {
    throw new ValidationError('匝数 turns 必须是有限数值', 'turns');
  }
  if (turns <= 0) {
    throw new ValidationError(
      `匝数 turns 必须大于 0（收到 ${turns}）；漏掉匝数会让标度因数差 N 倍`,
      'turns',
    );
  }
  if (!Number.isInteger(turns)) {
    throw new ValidationError(`匝数 turns 必须是正整数（收到 ${turns}）`, 'turns');
  }

  if (!isFiniteNumber(wavelength)) {
    throw new ValidationError('波长 wavelength 必须是有限数值', 'wavelength');
  }
  if (wavelength <= 0) {
    throw new ValidationError(
      `波长 wavelength 必须大于 0（收到 ${wavelength}）`,
      'wavelength',
    );
  }

  return { radius, turns, wavelength };
}

/** 校验单个角速度：任意有限实数均可（0、负值合法） */
export function validateOmega(value: unknown, field = 'omega'): number {
  if (!isFiniteNumber(value)) {
    throw new ValidationError('角速度必须是有限数值（rad/s）', field);
  }
  return value;
}

/** 校验一组角速度（逐点扫描输入），不允许为空 */
export function validateOmegaList(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('angularVelocities 必须是角速度数值数组', 'angularVelocities');
  }
  if (input.length === 0) {
    throw new ValidationError('角速度数组不能为空', 'angularVelocities');
  }
  return input.map((v, i) => validateOmega(v, `angularVelocities[${i}]`));
}

/**
 * 校验线性扫描网格。
 * count 为 >=2 的正整数（端点各采样一次）；start/stop 为有限实数，
 * 允许 start > stop（反向扫描），允许负值。
 */export function validateGrid(input: unknown): OmegaGrid {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('grid 必须是包含 start、stop、count 的对象', 'grid');
  }
  const gr = input as Record<string, unknown>;

  if (!('start' in gr)) throw new ValidationError('网格缺少起始角速度 start', 'grid.start');
  if (!('stop' in gr)) throw new ValidationError('网格缺少终止角速度 stop', 'grid.stop');
  if (!('count' in gr)) throw new ValidationError('网格缺少采样点数 count', 'grid.count');

  const start = gr.start;
  const stop = gr.stop;
  const count = gr.count;

  if (!isFiniteNumber(start)) {
    throw new ValidationError('网格起点 start 必须是有限数值', 'grid.start');
  }
  if (!isFiniteNumber(stop)) {
    throw new ValidationError('网格终点 stop 必须是有限数值', 'grid.stop');
  }
  if (!isFiniteNumber(count)) {
    throw new ValidationError('采样点数 count 必须是有限整数', 'grid.count');
  }
  if (!Number.isInteger(count) || count < 2) {
    throw new ValidationError(`采样点数 count 必须是不小于 2 的整数（收到 ${String(count)}）`, 'grid.count');
  }
  if (count > 10_000) {
    throw new ValidationError(`采样点数 count 过大（收到 ${count}），上限 10000`, 'grid.count');
  }

  return { start, stop, count };
}

/**
 * 校验采样间隔：必须是正有限数。
 * 连续相位序列的时间轴（t = i·dt）与缓变约束都建立在固定正采样间隔上。
 */
export function validateSampleInterval(value: unknown): number {
  if (!isFiniteNumber(value)) {
    throw new ValidationError('采样间隔 sampleInterval 必须是有限数值（s）', 'sampleInterval');
  }
  if (value <= 0) {
    throw new ValidationError(
      `采样间隔 sampleInterval 必须是正数（收到 ${value}）；` +
        `连续序列的时间轴与相邻点缓变约束都依赖一个固定为正的采样间隔`,
      'sampleInterval',
    );
  }
  return value;
}

/**
 * 校验按时间顺序排列的原始相位读数序列：非空、逐点为有限数值。
 * 读数应是仪器解调后卷绕在主值区间内的相位（rad）；这里只对“有限数值”
 * 做硬性校验，与几何参数校验风格一致——解缠算法对任何有限读数都有定义。
 */
export function validatePhaseSequence(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('phases 必须是按时间顺序排列的相位读数数组（rad）', 'phases');
  }
  if (input.length === 0) {
    throw new ValidationError('相位读数序列不能为空', 'phases');
  }
  return input.map((v, i) => {
    if (!isFiniteNumber(v)) {
      throw new ValidationError(
        `相位读数必须是有限数值（rad），第 ${i} 个读数不是有限数值`,
        `phases[${i}]`,
      );
    }
    return v;
  });
}

/**
 * 校验缓变约束的最大相位步长：必须 ∈ (0, π]。
 * 超过半个模糊周期 π 时，相邻点之间会同时存在多个可行的整周期补偿，
 * 整周期解算失去唯一性前提，必须拒绝。
 */
export function validateMaxPhaseStep(value: unknown): number {
  if (!isFiniteNumber(value)) {
    throw new ValidationError('最大相位步长 maxPhaseStep 必须是有限数值（rad）', 'maxPhaseStep');
  }
  if (value <= 0) {
    throw new ValidationError(
      `最大相位步长 maxPhaseStep 必须大于 0（收到 ${value}）`,
      'maxPhaseStep',
    );
  }
  if (value > Math.PI) {
    throw new ValidationError(
      `最大相位步长 maxPhaseStep 不能超过半个模糊周期 π（收到 ${value}）；` +
        `窗口过宽会让相邻点同时存在多个可行整周期补偿，整周期解算失去唯一性`,
      'maxPhaseStep',
    );
  }
  return value;
}
