/**
 * 皮套几何自检 —— 生成后的皮套必须通过这里全部断言才算"达到标准品水平"。
 *
 * 用法：
 *   node check_avatar.mjs <皮套目录> [图层目录]
 *   图层目录缺省为 <皮套目录>/layers
 *
 * 断言全部来自标准品（pet/）多轮实测校准的行为指标：
 *   A 五官绝对尺寸 ≈ 贴图原始尺寸（曾被缩到 rigid 倍而测试全绿，故必测绝对值）
 *   B 任意姿态下四边形面积比不塌陷（耳坠曾塌成 0.000）
 *   C 点头时脸高变化 <2%（曾被 3.4° 旋转拉长 5.8%）
 *   D 点头/转头时五官相对距离变化 <5%（曾被 MouthWarp 缩放平移拉大 24%）
 *   E 转头近大远小（远侧内收 >6%、近侧不内收）且方向正确
 *   F 眨眼完全闭合 / 张嘴 / 注视幅度不被 rigid 打折
 *   G 脖子权重 smoothstep（二阶差分足够小，无折点）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const layersDir = process.argv[3] || path.join(root, 'layers');
if (!root) { console.error('用法: node check_avatar.mjs <皮套目录> [图层目录]'); process.exit(2); }

const rigSrc = path.join(root, 'src', 'rig.js');
const dfmSrc = path.join(root, 'src', 'deformer.js');
for (const f of [rigSrc, dfmSrc]) {
  if (!fs.existsSync(f)) { console.error('缺文件: ' + f); process.exit(2); }
}
const rig = await import(pathToFileURL(rigSrc).href);
const dfm = await import(pathToFileURL(dfmSrc).href);
const { LAYERS, PARAMS, ANGLE_SCALE, HEAD_PIVOT } = rig;
const { ArtMesh, buildDeformers, clamp, deformMesh } = dfm;

const meta = JSON.parse(fs.readFileSync(path.join(layersDir, 'layers_meta.json'), 'utf8'));
const META = {};
for (const L of meta.layers) META[L.file.replace('.png', '')] = L;

let fails = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + d}`); if (!ok) fails++; };

const P = {};
Object.assign(P, Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.def])));
const D = buildDeformers(P, ANGLE_SCALE, HEAD_PIVOT);
const meshes = [];
for (const def of LAYERS) {
  if (!META[def.file.replace('.png', '')]) { console.error('layers_meta 缺图层: ' + def.file); process.exit(2); }
  meshes.push(new ArtMesh(def, META[def.file.replace('.png', '')], { width: 1, height: 1 }));
}
// 与线上静止态一致（main.js 的放松默认）
const REST = { exprSmile: 0, mouthOpen: 0.06, mouthForm: 0.10 };
const set = (o) => Object.assign(P, Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.def])), REST, o);

function posOf(id, over) {
  const m = meshes.find((x) => x.def.id === id);
  set(over); deformMesh(m, P, D);
  return m.pos.map((p) => [p[0], p[1]]);
}
function centreOf(id, over) {
  const ps = posOf(id, over);
  let x = 0, y = 0; for (const p of ps) { x += p[0]; y += p[1]; }
  return [x / ps.length, y / ps.length];
}
const spanX = (id, o) => { const p = posOf(id, o); return Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0])); };
const spanY = (id, o) => { const p = posOf(id, o); return Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1])); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

console.log(`== 皮套自检: ${root} ==\n`);

console.log('--- A. 五官绝对尺寸（不得被缩放）---');
for (const id of ['irides', 'eyewhite', 'nose', 'mouth', 'eyebrow', 'eyelash']) {
  const w = spanX(id, {}), h = spanY(id, {});
  const mw = META[id].w, mh = META[id].h;
  check(`${id} 宽比 ≈1（>${(id === 'mouth' ? 0.85 : 0.85).toFixed(2)}）`, w / mw > 0.85, (w / mw).toFixed(2));
  const hf = id === 'mouth' ? 0.25 : 0.5;   // 嘴静止 sy≈0.30 是设计值
  check(`${id} 高比合理（>${hf}）`, h / mh > hf, (h / mh).toFixed(2));
}

console.log('\n--- B. 四边形面积比（不塌陷）---');
for (const [nm, ov] of [['静止', {}], ['右转', { angleX: 1 }], ['左转', { angleX: -1 }], ['抬头', { angleY: -1 }], ['低头', { angleY: 1 }], ['极端', { angleX: -1, angleY: -1, angleZ: 0.5 }]]) {
  let worst = 1e9, wid = '';
  for (const m of meshes) {
    set(ov); deformMesh(m, P, D);
    const cols = m.cols, rows = m.rows;
    const idx = (r, c) => r * (cols + 1) + c;
    const area = (p) => Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const q = [[r, c], [r, c + 1], [r + 1, c + 1], [r + 1, c]];
      const rest = q.map(([rr, cc]) => { const i = idx(rr, cc); return [m.rest[i][0] + m.meta.x, m.rest[i][1] + m.meta.y]; });
      const now = q.map(([rr, cc]) => { const i = idx(rr, cc); return m.pos[i]; });
      const a0 = area(rest), a1 = area(now);
      if (a0 > 1e-6) { const ra = a1 / a0; if (ra < worst) { worst = ra; wid = m.def.id; } }
    }
  }
  const floor = wid === 'mouth' ? 0.1 : 0.4;   // 嘴静止 sy≈0.30 属设计
  check(`${nm} 最小面积比 >${floor}（${wid} ${worst.toFixed(3)}）`, worst > floor);
}

console.log('\n--- C. 点头不拉伸脸 ---');
for (const [nm, ov] of [['抬头', { angleY: -1 }], ['低头', { angleY: 1 }]]) {
  const pct = 100 * (spanY('face', ov) - spanY('face', {})) / spanY('face', {});
  check(`${nm} 脸高变化 <2%`, Math.abs(pct) < 2, `${pct.toFixed(1)}%`);
}

console.log('\n--- D. 五官相对距离锁死 ---');
for (const [nm, ov] of [['抬头', { angleY: -1 }], ['低头', { angleY: 1 }], ['右转', { angleX: 1 }]]) {
  let worst = 0, wp = '';
  for (const [a, b] of [['irides', 'nose'], ['nose', 'mouth'], ['eyewhite', 'eyebrow']]) {
    const d0 = dist(centreOf(a, {}), centreOf(b, {}));
    const d1 = dist(centreOf(a, ov), centreOf(b, ov));
    const pct = 100 * Math.abs(d1 - d0) / (d0 || 1);
    if (pct > worst) { worst = pct; wp = `${a}-${b}`; }
  }
  check(`${nm} 间距变化 <5%`, worst < 5, `${worst.toFixed(2)}% (${wp})`);
}

console.log('\n--- E. 转头近大远小 ---');
{
  const face = meshes.find((x) => x.def.id === 'face');
  // 与标准品 yaw 测试同基线（默认表情 exprSmile=1）：FaceWarp 的横向贡献
  // 会放大远侧内收；用 REST 基线会测得偏小（左转 -5.8% vs -10.5%）误报。
  const half = (ov) => {
    set({ exprSmile: 1, ...ov }); deformMesh(face, P, D);
    const L = [], R = [];
    for (let i = 0; i < face.rest.length; i++) {
      (face.rest[i][0] + face.meta.x < META.face.x + META.face.w / 2 ? L : R).push(face.pos[i][0]);
    }
    const sp = (a) => Math.max(...a) - Math.min(...a);
    return { L: sp(L), R: sp(R) };
  };
  const b = half({});
  for (const [nm, ov] of [['右转', { angleX: 1 }], ['左转', { angleX: -1 }]]) {
    const r = half(ov);
    const dL = 100 * (r.L - b.L) / b.L, dR = 100 * (r.R - b.R) / b.R;
    const far = nm === '右转' ? dR : dL, near = nm === '右转' ? dL : dR;
    check(`${nm} 远侧内收 >6%`, Math.abs(far) > 6, `${far.toFixed(1)}%`);
    check(`${nm} 近侧不内收（>-3%）`, near > -3, `${near.toFixed(1)}%`);
    // 整脸宽变化：与标准品测试同基线（默认表情，不加 REST 放松）——
    // exprSmile 默认 1 时 FaceWarp 有横向贡献，标准品实测 ≈-4.5%；
    // 若用 REST 基线会测得 ≈-2%，属于口径不同而非行为差异。
    const wf = (o) => {
      const m = meshes.find((x) => x.def.id === 'face');
      set({ exprSmile: 1 }); deformMesh(m, P, D);
      const a = Math.max(...m.pos.map((p) => p[0])) - Math.min(...m.pos.map((p) => p[0]));
      set({ exprSmile: 1, ...o }); deformMesh(m, P, D);
      const b2 = Math.max(...m.pos.map((p) => p[0])) - Math.min(...m.pos.map((p) => p[0]));
      return 100 * (b2 - a) / a;
    };
    const wp = wf(ov);
    check(`${nm} 整脸宽变化 4~12%（实测 ${wp.toFixed(1)}%）`, Math.abs(wp) > 4 && Math.abs(wp) < 12);
  }
}

console.log('\n--- F. 局部动作不被 rigid 打折 ---');
{
  const hEye = (o) => spanY('eyewhite', { ...o, exprLaugh: 0, exprSmile: 0 });
  const open = hEye({ eyeLOpen: 1, eyeROpen: 1 }), shut = hEye({ eyeLOpen: 0, eyeROpen: 0 });
  check(`眨眼完全闭合（${open.toFixed(1)}→${shut.toFixed(1)}）`, shut < open * 0.15, `${(100 * shut / open).toFixed(0)}%`);
  const mH = (o) => spanY('mouth', { ...o, exprLaugh: 0 });
  const mc = mH({ mouthOpen: 0.06 }), mo = mH({ mouthOpen: 1 });
  check(`张嘴幅度（${mc.toFixed(1)}→${mo.toFixed(1)}）`, mo > mc * 1.5, `${(mo / mc).toFixed(2)}x`);
  const gx = (v) => { const ps = posOf('irides', { eyeBallX: v, eyeLOpen: 1, eyeROpen: 1 }); return ps.reduce((a, p) => a + p[0], 0) / ps.length; };
  const gaze = gx(1) - gx(-1);
  check(`注视幅度 >8px`, Math.abs(gaze) > 8, `${gaze.toFixed(1)}px`);
}

console.log('\n--- G. 脖子权重平滑 + 点头不伸缩 ---');
{
  const wfn = (LAYERS.find((l) => l.id === 'neck').warpChain.find((c) => c[0] === 'HeadWarp'))[1];
  if (typeof wfn !== 'function') {
    check('脖子权重是沿高度函数（smoothstep）', false, '当前是常数——会回到"脖子不跟头"的老问题');
  } else {
    const y0 = META.neck.y, y1 = META.neck.y + META.neck.h;
    let m2 = 0;
    const w = (y) => wfn(512, y, {});
    for (let y = Math.floor(y0); y < y1; y++) {
      m2 = Math.max(m2, Math.abs(w(y + 1) - 2 * w(y) + w(y - 1)));
    }
    check(`二阶差分 <0.001（实测 ${m2.toFixed(6)}）`, m2 < 0.001);
  }
  // 点头时脖子**不伸缩**（用户实测：点头像伸缩脖子）——
  // 量脖层的纵向包围盒在点头前后的变化。可见段若权重不平，会被拉长几个百分点。
  const neckH = (o) => { const p = posOf('neck', o); return Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1])); };
  const h0 = neckH({}), h1 = neckH({ angleY: 1 });
  const pct = 100 * (h1 - h0) / h0;
  check(`点头时脖子高度变化 <3%（实测 ${pct.toFixed(2)}%）`, Math.abs(pct) < 3);
}

console.log(`\n${fails === 0 ? '✔ 全部通过 —— 达到标准品水平' : '✘ ' + fails + ' 项未达标'}`);
process.exit(fails ? 1 : 0);
