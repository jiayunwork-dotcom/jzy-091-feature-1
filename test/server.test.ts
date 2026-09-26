/**
 * HTTP 端到端测试（Fastify inject，不起真实端口）：
 * 覆盖 /phase、/calibrate、/scan、/closed-loop、/reference、/health
 * 以及 400 错误 JSON、模糊显式告警、扫描逐点真算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { wrapToPrincipal } from '../src/ambiguity.js';
import { sagnacPhase } from '../src/sagnac.js';

const app = buildServer();

const geometry = { radius: 0.05, turns: 640, wavelength: 1.55e-6 };

test('GET /health', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok', service: 'fog-sagnac-kernel' });
});

test('GET /reference 给出约 200 m 线圈与地球自转微弧度级相位', async () => {
  const res = await app.inject({ method: 'GET', url: '/reference' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.fiberLength > 199 && body.fiberLength < 203);
  assert.ok(body.earthRotation.phaseMicroRad > 10 && body.earthRotation.phaseMicroRad < 30);
  assert.ok(Math.abs(body.earthRotation.phaseMicroRad - 19.82) / 19.82 < 1e-3);
});

test('POST /phase 返回相位、标度因数、反演角速度', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/phase',
    payload: { geometry, omega: 1e-4 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.fiberLength > 201 && body.fiberLength < 201.1);
  assert.ok(Math.abs(body.scaleFactor - 0.271867) / 0.271867 < 1e-4);
  assert.ok(Math.abs(body.phase - body.scaleFactor * 1e-4) < 1e-15);
  assert.ok(Math.abs(body.omegaHat - 1e-4) < 1e-15);
  assert.equal(body.ambiguity.ambiguous, false);
});

test('POST /phase 反号输入 → 相位反号绝对值不变', async () => {
  const [pos, neg] = await Promise.all([
    app.inject({ method: 'POST', url: '/phase', payload: { geometry, omega: 1e-4 } }),
    app.inject({ method: 'POST', url: '/phase', payload: { geometry, omega: -1e-4 } }),
  ]);
  const p = pos.json().phase;
  const n = neg.json().phase;
  assert.ok(Math.abs(p + n) < 1e-18);
});

test('半径加倍（匝数不变）→ /phase 相位 4 倍、总长 2 倍', async () => {
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/phase', payload: { geometry, omega: 1e-4 } }),
    app.inject({
      method: 'POST',
      url: '/phase',
      payload: { geometry: { ...geometry, radius: 0.1 }, omega: 1e-4 },
    }),
  ]);
  assert.ok(Math.abs(b.json().fiberLength / a.json().fiberLength - 2) < 1e-12);
  assert.ok(Math.abs(b.json().phase / a.json().phase - 4) < 1e-12);
});

test('POST /phase 半径为零 → 400 且返回带原因的错误 JSON', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/phase',
    payload: { geometry: { radius: 0, turns: 640, wavelength: 1.55e-6 }, omega: 1 },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'invalid_request');
  assert.equal(body.field, 'radius');
  assert.match(body.reason, /大于 0/);
});

test('波长为零、匝数为负、缺字段、非法 JSON 均为 400', async () => {
  const cases: Record<string, unknown>[] = [
    { geometry: { ...geometry, wavelength: 0 }, omega: 1 },
    { geometry: { ...geometry, turns: -1 }, omega: 1 },
    { geometry: { radius: 0.05, turns: 640 }, omega: 1 },
    { omega: 1 },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: 'POST', url: '/phase', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, 'invalid_request');
  }
  const badJson = await app.inject({
    method: 'POST',
    url: '/phase',
    headers: { 'content-type': 'application/json' },
    payload: '{not json',
  });
  assert.equal(badJson.statusCode, 400);
});

test('POST /calibrate 正常反演', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/calibrate',
    payload: { geometry, phase: 2e-5 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Math.abs(body.omegaHat - 2e-5 / body.scaleFactor) < 1e-20);
  assert.equal(body.ambiguity.ambiguous, false);
});

test('POST /calibrate 近 π 相位必须 200 但显式模糊告警，且不折叠', async () => {
  const phase = 1.5 * Math.PI;
  const res = await app.inject({
    method: 'POST',
    url: '/calibrate',
    payload: { geometry, phase },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ambiguity.ambiguous, true);
  assert.match(body.ambiguity.warning, /模糊/);
  // 不折叠：按 1.5π 线性反演
  assert.ok(Math.abs(body.omegaHat - phase / body.scaleFactor) < 1e-15);
  assert.ok(Math.abs(body.measuredPhase - phase) < 1e-15);
});

test('POST /scan 用数组逐点真算', async () => {
  const omegas = [-2e-4, -1e-4, 0, 1e-4, 2e-4];
  const res = await app.inject({
    method: 'POST',
    url: '/scan',
    payload: { geometry, angularVelocities: omegas },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 5);
  body.samples.forEach((s: { omega: number; phase: number }, i: number) => {
    assert.equal(s.omega, omegas[i]);
    assert.ok(Math.abs(s.phase - body.scaleFactor * omegas[i]) < 1e-16);
  });
});

test('POST /scan 用网格逐点真算且包含零相位点', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/scan',
    payload: { geometry, grid: { start: -1e-4, stop: 1e-4, count: 5 } },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const expectedOmegas = [-1e-4, -5e-5, 0, 5e-5, 1e-4];
  body.samples.forEach((s: { omega: number; phase: number }, i: number) => {
    assert.ok(Math.abs(s.omega - expectedOmegas[i]) < 1e-18);
  });
  assert.equal(body.samples[2].phase, 0);
});

test('POST /scan 同时给数组与网格 / 都不给 → 400', async () => {
  const both = await app.inject({
    method: 'POST',
    url: '/scan',
    payload: { geometry, angularVelocities: [1], grid: { start: 0, stop: 1, count: 2 } },
  });
  assert.equal(both.statusCode, 400);
  const neither = await app.inject({ method: 'POST', url: '/scan', payload: { geometry } });
  assert.equal(neither.statusCode, 400);
});

test('POST /closed-loop 薄层反演', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/closed-loop',
    payload: { geometry, feedbackPhase: 2e-5 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Math.abs(body.omega - 2e-5 / body.scaleFactor) < 1e-20);
  assert.match(body.note, /闭环/);
});

test('未知路由返回 404 JSON', async () => {
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('POST /unwrap 小角速度序列与单点反演一致且不补整圈', async () => {
  const phases = [0, 1e-5, 2e-5, 1e-5, 0];
  const res = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry, samplingInterval: 0.05, phases },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 5);
  assert.equal(body.samplingInterval, 0.05);
  for (let i = 0; i < phases.length; i++) {
    const s = body.samples[i];
    assert.equal(s.rawPhase, phases[i]);
    assert.equal(s.cycleOffset, 0);
    // 与“同样的相位逐点丢给现有单点反演链路”的结果数值一致
    const single = await app.inject({
      method: 'POST',
      url: '/calibrate',
      payload: { geometry, phase: phases[i] },
    });
    assert.ok(Math.abs(s.omegaHat - single.json().omegaHat) < 1e-25, `点 ${i} 与单点反演不一致`);
  }
});

test('POST /unwrap 人为卷绕序列往返还原（很多单点单独看已超模糊阈值）', async () => {
  const omegas = Array.from({ length: 40 }, (_, i) => 30 * (i / 39));
  const truePhases = omegas.map((w) => sagnacPhase(geometry, w));
  const phases = truePhases.map(wrapToPrincipal);
  assert.ok(phases.some((p, i) => Math.abs(p - truePhases[i]) > Math.PI), '测试前提：序列含截断点');
  const res = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: { geometry, samplingInterval: 0.04, phases },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  body.samples.forEach((s: { omegaHat: number; cycleStep: number | null }, i: number) => {
    assert.ok(Math.abs(s.omegaHat - omegas[i]) < 1e-8, `点 ${i} 轨迹还原不符`);
  });
  assert.ok(body.samples.some((s: { cycleStep: number | null }) => s.cycleStep !== null && s.cycleStep !== 0));
});

test('POST /unwrap 缓变约束不满足 → 422 且指出具体采样点与枚举候选', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/unwrap',
    payload: {
      geometry,
      samplingInterval: 0.05,
      phases: [0, 0.1 * Math.PI, wrapToPrincipal(0.7 * Math.PI)],
      maxPhaseStep: 0.5 * Math.PI,
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'unwrap_constraint_violation');
  assert.equal(body.index, 2);
  assert.equal(body.field, 'phases[2]');
  assert.equal(body.kind, 'no_valid_cycle');
  assert.ok(Array.isArray(body.candidates) && body.candidates.length > 0);
});

test('POST /unwrap 采样间隔非正 / 序列含 NaN / 空序列 → 400 带原因', async () => {
  const cases: Record<string, unknown>[] = [
    { geometry, samplingInterval: 0, phases: [0, 1] },
    { geometry, samplingInterval: -0.01, phases: [0, 1] },
    { geometry, samplingInterval: 0.05, phases: [0, Number.NaN] },
    { geometry, samplingInterval: 0.05, phases: [] },
    { geometry, phases: [0, 1] },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: 'POST', url: '/unwrap', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, 'invalid_request');
    assert.ok(typeof res.json().reason === 'string');
  }
});
