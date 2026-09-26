# FOG Sagnac 计算内核

光纤陀螺实验台的**纯后端干涉陀螺计算内核**：根据线圈几何（半径 R、匝数 N、
真空波长 λ）与输入角速度 Ω 还原 Sagnac 干涉相位，并由实测相位反演标定角速度。
仅通过 HTTP（Fastify）工作，无网页界面，不做罗盘/航迹显示，也不含惯导误差状态滤波。

运行时：**Node.js 20 + TypeScript（编译为 JS 产物执行）+ Fastify**。

## 物理模型

```
光纤总长度   L   = 2π · R · N                （一圈周长 × 匝数，绝不能漏 N）
Sagnac 相位  Δφ  = 4π · R · L · Ω / (λ · c)  = K · Ω
标度因数     K   = 4π · R · L / (λ · c)       [s]
反演角速度   Ω̂   = Δφ / K
```

真空光速固定 `c = 2.99792458e8 m/s`。

**内置参考线圈**：R = 0.05 m，N = 640，λ = 1.55 μm ⇒ L ≈ 201.06 m，K ≈ 0.2719 s。
在地球自转 Ω_E = 7.2921159e-5 rad/s 下 **Δφ ≈ 1.982e-5 rad ≈ 19.8 μrad**，
为可检出的微弧度级相位，供快速核对量纲与系数（`GET /reference`）。

**相位模糊**：开环干涉对 cos(Δφ) 敏感、周期 2π。当 |Δφ| ≥ 0.9π 时响应
**显式返回 `ambiguity.ambiguous = true` 与中文警告**；服务绝不折叠相位，
Ω̂ 始终按原始相位线性反演，不会返回被悄悄换到错误象限的“看似正常”角速度。

闭环只做一层很薄的偏置/反馈修正（稳态 φ_err = Δφ ⇒ Ω = φ_err/K），
不含滤波与误差状态估计。

**连续序列整周期解算**：解调电路按固定采样间隔 dt 吐出一串卷绕在主值
区间的原始相位。在角速度缓变（一个采样间隔内真实相位步长不超过半个
模糊周期 π）的前提下，逐点枚举相对上一点的整周期补偿量 k，使
`ΔΦ_i = p_i − p_{i−1} + 2π·k` 满足 `|ΔΦ_i| ≤ maxPhaseStep`：B ≤ π 时
可行 k 至多一个，序列由此唯一展开为连续相位历程再反演角速度。找不到
可行 k（真突变/数据缺口）或边界上两个 k 同样可行（恰好 ±π）时，
**显式报出具体是哪个采样点（HTTP 422）并拒绝输出轨迹，绝不硬选最近
补偿量**。参考点固定首点 cycleOffset=0：相邻差异只能消除相对整周期
歧义，全序列共有的 2π 绝对偏移需量程先验另行消除。

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/config.ts` | 光速、模糊阈值、参考线圈、地球自转常数 |
| `src/types.ts` | 共享类型 |
| `src/validation.ts` | 输入校验（R/N/λ ≤ 0 等一律带原因拒绝） |
| `src/geometry.ts` | 圈周长、**含匝数 N 的**光纤总长、标度因数 |
| `src/sagnac.ts` | 相位正算、相位反演角速度（主链路） |
| `src/ambiguity.ts` | 近 π 模糊判定（只告警，不折叠反演） |
| `src/scan.ts` | 角速度网格/数组逐点真算采样 |
| `src/closedloop.ts` | 闭环薄层修正 |
| `src/unwrap.ts` | 连续相位序列整周期枚举/展开、缓变约束违例定位 |
| `src/reference.ts` | 内置参考线圈核对信息 |
| `src/server.ts` | Fastify HTTP 路由与错误 JSON |
| `src/index.ts` | 入口，监听固定端口 3000 |

## 本地构建与运行

```bash
npm install
npm run build
npm start            # http://localhost:3000
npm test             # tsc 编译 + node --test dist/test/
```

## Docker

```bash
docker build -t fog-sagnac-kernel .
docker run --rm -p 3000:3000 fog-sagnac-kernel
docker run --rm fog-sagnac-kernel npm test   # 容器内运行自动化测试
```

## HTTP 接口

### `GET /health`
存活探针。

### `GET /reference`
内置约 200 m 参考线圈的 L、K 与地球自转下的相位（rad 与 μrad）。

### `POST /phase`（类别一：单角速度正算）
请求：
```json
{ "geometry": { "radius": 0.05, "turns": 640, "wavelength": 1.55e-6 }, "omega": 1e-4 }
```
返回：`geometry, fiberLength, omega, phase, scaleFactor, omegaHat, ambiguity`。

### `POST /calibrate`（类别二：实测相位反演）
请求：`{ "geometry": {...}, "phase": 0.00002 }`（可选 `threshold` 覆盖 0.9π）。
返回：`measuredPhase, scaleFactor, omegaHat, ambiguity`；近 π 时带显式警告。

### `POST /scan`（角速度扫描）
二选一：
```json
{ "geometry": {...}, "angularVelocities": [-0.0002, 0, 0.0002] }
{ "geometry": {...}, "grid": { "start": -0.0001, "stop": 0.0001, "count": 5 } }
```
返回 `samples: [{ omega, phase }, ...]`，**逐点真算**（每点独立走完整正算链路）。

### `POST /closed-loop`（闭环薄层）
请求：`{ "geometry": {...}, "feedbackPhase": 0.00002 }` ⇒ `omega`。

### `POST /unwrap`（连续相位序列整周期解算）
请求：
```json
{
  "geometry": { "radius": 0.05, "turns": 640, "wavelength": 1.55e-6 },
  "samplingInterval": 0.05,
  "phases": [0.0, 3.1, -2.9, -0.2],
  "maxPhaseStep": 3.14159265
}
```
`maxPhaseStep` 可选，默认 π（缓变约束，取值范围 (0, π]）。
返回 `samplingInterval, count, maxPhaseStep, maxOmegaStep (=B/K), anchor` 与
逐点 `samples`：每点含 `time`、`rawPhase`、**`cycleOffset`（相对首点累计补的
整圈数）**、`cycleStep`（相对上一点补的整圈数）、`unwrappedPhase`、`omegaHat`、
`phaseStep`、**`deltaOmega`（补偏移后前后两点角速度变化幅度）**——每一点补了
几圈、解完之后变化多大均可直接审查。长度为 1 的序列退化为对单点反演的调用。

缓变约束不满足时返回 **422**：
```json
{ "error": "unwrap_constraint_violation", "field": "phases[3]", "index": 3,
  "kind": "no_valid_cycle", "reason": "……", "candidates": [ { "cycleStep": 0, "phaseStep": 4.2, "absPhaseStep": 4.2 } ] }
```
`kind` 为 `no_valid_cycle`（任何整周期补偿都超限，真突变/数据缺口）或
`boundary_tie`（步长恰好 ±B，两个补偿量同样可行、不可判定）。

### 错误格式（HTTP 400）
```json
{ "error": "invalid_request", "field": "radius", "reason": "半径 radius 必须大于 0（收到 0）……" }
```

## 测试锁定的交叉关系

- **反号对称**：Ω → −Ω ⇒ Δφ → −Δφ，绝对值不变；
- **半径加倍（N 不变）**：L 加倍、Δφ 变 4 倍；
- **波长加倍**：Δφ 减半；
- **半径为零**：带原因的 400 错误；
- **N 倍坑**：显式断言“漏掉匝数的错误 K”恰好差 N 倍；
- 正反演往返一致、近 π 不折叠、扫描逐点真算、两组配置同进程隔离。
- **序列退化一致性**：小角速度（全程远离半模糊周期）合成序列走 /unwrap
  与逐点走 /calibrate 反演结果数值完全一致，cycleOffset 全为 0；
- **卷绕往返还原**：已知连续轨迹（线性爬升/正弦摆动）正算 → 按 2π 主值
  人为截断 → /unwrap，解出的角速度轨迹必须还原原始轨迹，即使大量单点
  单独看已超模糊阈值；
- **违例定位**：某一步任何整周期补偿都无法满足缓变约束（或恰好压在 ±π
  边界）时，422 明确指出该采样点序号并给出枚举候选，不输出轨迹。
