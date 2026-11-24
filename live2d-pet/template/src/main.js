/**
 * main.js — 皮套主程序
 */

import { CANVAS, LAYERS, PARAMS, ANGLE_SCALE, HEAD_PIVOT } from './rig.js';
import { ArtMesh, buildDeformers, clamp } from './deformer.js';
import { Renderer } from './renderer.js';
import { FaceTracker } from './tracking.js';

const LAYER_META = {};   // id -> {x,y,w,h}

const $ = (s) => document.querySelector(s);

let renderer, deformers, meshes = [];
let P = {};              // 供变形器读取的最终参数
const SMOOTH = {};       // 平滑后的「基础量」（跟踪/手动/待机），不含表情派生
let target = {};         // 追踪目标参数
let manual = {};         // 手动覆盖
let tracker = null;
let useTracking = true;
// 方向修正开关：不同摄像头/驱动的镜像约定不一致，导致「摇头反向」。
// 与其在代码里猜符号，不如给用户两个开关现场纠正。
let flipX = false, flipY = false;
// 暂停主渲染循环（自检期间使用，避免主循环往同一画布上重绘干扰测量）
let paused = false;
let lastT = performance.now();
let fps = 0, fpsAcc = 0, fpsN = 0;

// 待机动画相位
let idlePhase = 0;
// 身体跟随头部的滞后量（规则 20：约 1/3 幅度且滞后）
let bodyFollow = 0;
// 镜头外保持：最后有效追踪 + 已保持时长
let lastGood = null;
let holdT = 0;
const HOLD_MAX = 3.0;   // 出画后保持 3 秒，再 1.5 秒滑回待机

// 设备像素比。必须是模块级：applyViewport()（全屏重排）也要用。
const DPR = Math.min(window.devicePixelRatio || 1, 2);
// 进入全屏前的直播模式状态，用于退出全屏时还原
let liveWasOn = false;

function defaultParams() {
  const o = {};
  for (const [k, v] of Object.entries(PARAMS)) o[k] = v.def;
  // 静止态应当是「自然放松」而不是固定的微笑：
  // 之前把 exprSmile 常驻 0.55、mouthForm 又逐帧累加，导致表情被顶到上限、
  // 与人脸追踪互相打架，看起来僵硬不自然。
  o.exprSmile = 0.0;
  o.exprCalm = 0.35;
  o.exprLaugh = 0;
  o.exprBlink = 0;
  o.mouthOpen = 0.06;
  o.mouthForm = 0.10;
  return o;
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function boot() {
  setStatus('读取图层元数据…');
  const meta = await (await fetch('./layers/layers_meta.json')).json();

  // 建立画布坐标映射：把 1024 的 PSD 画布映射到显示画布
  // 皮套只用到上半身，裁掉空白
  const SRC = { x: 140, y: 0, w: 760, h: 900 };

  for (const L of meta.layers) {
    LAYER_META[L.file.replace('.png', '')] = L;
  }

  // ⚠️ 必须先初始化 P，再 buildDeformers：
  //    变形器闭包持有的是 P 这个「对象引用」，一旦 P 被整体重新赋值（P = ...），
  //    闭包仍旧指向旧对象 → 所有参数读成 undefined → 坐标变 NaN → 画面撕裂。
  //    所以这里先把默认值填进当前对象（原地修改，不换引用）。
  Object.assign(P, defaultParams());

  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');

  renderer = new Renderer(canvas, ctx);
  renderer.srcBox = SRC;
  // 画布尺寸与坐标映射统一交给 applyViewport()（它同时负责全屏时的重排）：
  //   普通模式 = SRC 固定尺寸；全屏模式 = 屏幕比例、皮套等比缩放居中
  // 逻辑坐标 → 设备坐标：  device = (canvasPos - SRC.xy) * scale
  applyViewport();

  // P 已是完整对象，闭包引用正确
  deformers = buildDeformers(P, ANGLE_SCALE, HEAD_PIVOT);

  setStatus('加载图层…');
  for (const def of LAYERS) {
    const key = def.file.replace('.png', '');
    const m = LAYER_META[key];
    if (!m) { console.warn('missing meta for', key); continue; }
    const img = await loadImage('./layers/' + def.file);
    const mesh = new ArtMesh(def, m, img);
    meshes.push(mesh);
    renderer.addMesh(mesh);
  }

  // 保持 P 的引用不变（变形器闭包依赖它），只覆盖内容
  target = { ...P };
  Object.assign(SMOOTH, P);   // 基础量从默认值起步
  manual = {};

  buildUI();
  setStatus('就绪');
  checkBuild();
  requestAnimationFrame(frame);
}

/**
 * 本文件的构建版本号 —— 由 serve.py 在返回 main.js 时把 __BUILD__ 替换成真实值。
 *
 * 关键点：这个常量存在于 **JS 自己** 里面。
 * 所以「拿它和服务器 /build.json 比对」测的是
 * **浏览器实际执行的 JS 是不是最新的** —— 这正是我们关心的东西。
 * （若改成去读 index.html 里的数字，那么 HTML 与 JS 各自被缓存时会误判。）
 */
const MY_BUILD = '__BUILD__';

/**
 * 校验「浏览器里跑的 JS」是否与「服务器上的最新代码」一致。
 * 不一致就把标题旁的徽章标红，并在状态栏给出按 Ctrl+F5 的提示。
 */
async function checkBuild() {
  const el = $('#build');
  if (el) el.textContent = MY_BUILD;
  try {
    const r = await fetch('./build.json?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    const theirs = String(j.build);
    // 用「归一化后的字符串 + 数值」双重判断，避免空白/类型差异造成误报
    const mineN = String(MY_BUILD).trim();
    const theirsN = String(theirs).trim();
    const same = mineN === theirsN ||
                 (Number.isFinite(Number(mineN)) && Number(mineN) === Number(theirsN));
    if (!same) {
      // 确实不一致（页面上的 JS 落后于服务器）→ 提示刷新
      if (el) { el.classList.add('stale'); el.textContent = mineN + ' ≠ ' + theirsN; }
      setStatus('⚠ 浏览器仍在用缓存的旧 JS（页面 ' + mineN + ' / 服务器 ' + theirsN +
                '）。请按 Ctrl+Shift+R 强制刷新。');
    } else {
      if (el) { el.classList.remove('stale'); el.textContent = mineN; }
    }
  } catch (_) { /* 取不到版本就不提示 */ }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('failed ' + src));
    i.src = src;
  });
}

/** 用当前 P 渲染一帧（自检用，不走主循环） */
function renderOnce() {
  renderer.render(P, deformers, {
    scale: renderer.display.scale,
    offsetX: renderer.display.offX,
    offsetY: renderer.display.offY,
  });
}

/**
 * 残影自检 —— 在**你自己的浏览器里**测「本帧结果是否依赖上一帧」。
 *
 * 判据：先渲染姿态 A、紧接着渲染姿态 B，把结果记下来；
 *      再强制清屏后单独渲染姿态 B，与刚才的结果逐像素比较。
 *      若两者不同，差异部分就是「上一帧残留」。
 *
 * 返回差异像素占比（%）。0 表示没有任何跨帧残留。
 */
function measureGhosting() {
  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const N = w * h;

  // 两个差异极大的姿态：大幅度摇头 + 甩发
  const poseA = { angleX: -1, angleY: 0.4, angleZ: 0.3, hairSway: 1, hairSwayY: 0.6 };
  const poseB = { angleX: 1, angleY: -0.4, angleZ: -0.3, hairSway: -1, hairSwayY: -0.6 };

  const backup = { ...P };
  // 暂停主渲染循环 —— 否则它会往同一块画布上再画，干扰测量
  const wasPaused = paused;
  paused = true;

  const hardClear = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
  };
  const grab = () => ctx.getImageData(0, 0, w, h).data;

  /** 比较两张图像，返回差异统计 + 差异像素的包围盒 + 若干样本 */
  const compare = (a, b) => {
    let n = 0, worst = 0, wx = 0, wy = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    const samples = [];
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
                Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
      if (d > 8) {
        n++;
        const p = i >> 2, x = p % w, y = (p / w) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (samples.length < 4) {
          samples.push(`(${x},${y}) A=[${a[i]},${a[i + 1]},${a[i + 2]},${a[i + 3]}] ` +
                       `B=[${b[i]},${b[i + 1]},${b[i + 2]},${b[i + 3]}]`);
        }
      }
      if (d > worst) { worst = d; wx = (i >> 2) % w; wy = ((i >> 2) / w) | 0; }
    }
    return { pct: 100 * n / N, worst, bbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
             worstAt: [wx, wy], samples };
  };

  const out = {};
  try {
    // ---- 测试 1：确定性。同一姿态连渲两次应完全一致 ----
    hardClear(); Object.assign(P, poseB); renderOnce();
    const b1 = grab();
    hardClear(); Object.assign(P, poseB); renderOnce();
    const b2 = grab();
    out.determinism = compare(b1, b2);

    // ---- 测试 2：跨帧残留。先渲 A 再渲 B，与「清屏后单独渲 B」比较 ----
    hardClear(); Object.assign(P, poseA); renderOnce();
    Object.assign(P, poseB); renderOnce();
    const seq = grab();
    hardClear(); Object.assign(P, poseB); renderOnce();
    const ref = grab();
    out.ghost = compare(seq, ref);

    out.size = [w, h];
  } catch (e) {
    out.error = e.message;
  } finally {
    Object.assign(P, backup);
    paused = wasPaused;
  }
  return out;
}

/** 把自检结果显示到界面（同时打印到控制台，便于复制） */
function runGhostSelfCheck() {
  const btn = $('#btnGhost');
  if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
  // 让浏览器先完成一帧绘制，避免阻塞
  requestAnimationFrame(() => setTimeout(() => {
    const r = measureGhosting();
    if (r.error) {
      setStatus('残影自检失败：' + r.error);
      if (btn) { btn.disabled = false; btn.textContent = '残影自检'; }
      return;
    }
    const d = r.determinism, g = r.ghost;
    const lines = [
      '画布 ' + r.size[0] + '×' + r.size[1],
      '【确定性】同姿态连渲两次差异 ' + d.pct.toFixed(3) + '%  最大 ' + d.worst,
      '【跨帧残留】A→B 与 单独B 差异 ' + g.pct.toFixed(3) + '%  最大 ' + g.worst,
    ];
    if (g.bbox) lines.push('  残留区域 x[' + g.bbox[0] + '..' + g.bbox[2] + '] y[' + g.bbox[1] + '..' + g.bbox[3] + ']');
    if (g.samples && g.samples.length) lines.push('  样本 ' + g.samples[0]);
    if (d.pct > 0.01) lines.push('  ⚠ 同姿态两次渲染就不一致 → 属于「渲染不确定」，不是上一帧残留');
    else if (g.pct > 0.01) lines.push('  ⚠ 同姿态一致但 A→B 不一致 → 确实是「上一帧残留」');

    console.log('=== 残影自检 ===\n' + lines.join('\n'));

    const ok = g.pct < 0.01 && d.pct < 0.01;
    setStatus((ok ? '✅ 自检通过：无跨帧残留（' : '❌ 检出问题（') +
              '确定性 ' + d.pct.toFixed(2) + '% / 残留 ' + g.pct.toFixed(2) + '%）' +
              (g.bbox ? ' 残留区 x' + g.bbox[0] + '-' + g.bbox[2] + ' y' + g.bbox[1] + '-' + g.bbox[3] : '') +
              '（详细结果见控制台 F12）');
    if (btn) { btn.disabled = false; btn.textContent = '残影自检'; }
  }, 0));
}

function setStatus(s, isError) {
  const el = $('#status');
  if (el) {
    el.textContent = s;
    // 出错时用暖色标出，避免"背景没设上"这类问题被当成正常状态忽略
    el.style.color = isError ? '#f6ad55' : '';
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  // 自检期间暂停绘制（但仍保持 rAF 循环，便于恢复）
  if (paused) { requestAnimationFrame(frame); return; }

  // ---- 待机动画 ----
  idlePhase += dt;
  const breath = Math.sin(idlePhase * 1.5) * 0.5;
  const idleYaw = Math.sin(idlePhase * 0.42) * 0.10;
  const idlePitch = Math.sin(idlePhase * 0.31 + 1.1) * 0.07;
  const idleSway = Math.sin(idlePhase * 0.55 + 0.7) * 0.22;
  // 自然眨眼
  const blinkT = idlePhase % 4.2;
  let autoBlink = 1;
  if (blinkT > 3.85) {
    const k = (blinkT - 3.85) / 0.35;
    autoBlink = 1 - Math.sin(k * Math.PI) * 0.98;
  }

  // ---- 目标参数 ----
  // 镜头外保持：人出画后**保持最后姿态** HOLD_MAX 秒（用户要求"跟着镜头外
  // 的人位移"），之后在 1.5 秒内缓慢滑回待机——直接跳变会一惊一乍。
  let tgt = { ...target };
  if (useTracking && tracker && tracker.lastResult && tracker.lastResult.hasFace) {
    lastGood = { ...tracker.lastResult };
    holdT = 0;
    tgt = { ...lastGood };
    // 方向修正：摄像头驱动的镜像约定不一致时，用开关翻转
    if (flipX) {
      tgt.angleX = -tgt.angleX;
      tgt.eyeBallX = -tgt.eyeBallX;
    }
    if (flipY) {
      tgt.angleY = -tgt.angleY;
      tgt.eyeBallY = -tgt.eyeBallY;
    }
  } else {
    holdT += dt;
    const idleT = {
      angleX: idleYaw,
      angleY: idlePitch,
      angleZ: Math.sin(idlePhase * 0.23) * 0.06,
      eyeBallX: Math.sin(idlePhase * 0.6) * 0.3,
      eyeBallY: Math.sin(idlePhase * 0.44) * 0.15,
      eyeLOpen: autoBlink,
      eyeROpen: autoBlink,
      mouthOpen: 0.05 + Math.abs(Math.sin(idlePhase * 0.5)) * 0.06,
      mouthForm: 0.15 + Math.sin(idlePhase * 0.35) * 0.08,
      hairSway: idleSway * 0.5,
      hairSwayY: Math.sin(idlePhase * 0.5) * 0.15,
    };
    if (lastGood && holdT < HOLD_MAX) {
      // 保持期：原样沿用最后姿态（含方向修正）
      tgt = { ...lastGood };
      if (flipX) { tgt.angleX = -tgt.angleX; tgt.eyeBallX = -tgt.eyeBallX; }
      if (flipY) { tgt.angleY = -tgt.angleY; tgt.eyeBallY = -tgt.eyeBallY; }
    } else {
      // 回归期：在 1.5s 内从最后姿态滑到待机
      const mix = clamp((holdT - HOLD_MAX) / 1.5, 0, 1);
      tgt = { ...target };
      for (const k of Object.keys(idleT)) {
        const good = lastGood ? (lastGood[k] ?? tgt[k]) : tgt[k];
        tgt[k] = good * (1 - mix) + idleT[k] * mix;
      }
      if (flipX) { tgt.angleX = -tgt.angleX; tgt.eyeBallX = -tgt.eyeBallX; }
      if (flipY) { tgt.angleY = -tgt.angleY; tgt.eyeBallY = -tgt.eyeBallY; }
    }
  }

  // 手动覆盖优先
  for (const [k, v] of Object.entries(manual)) tgt[k] = v;

  // 呼吸始终叠加
  tgt.breath = breath;

  // ---- 身体跟随头部（skill 规则 20）----
  // 「脖子以上整体平移，躯干按圆柱转，腰以下不动；身体跟随头部取约三分之一幅度并滞后」
  //
  // 之前 bodyAngleX 声明了、BodyWarp 也读了，但**没有任何地方去驱动它** ——
  // 所以身体一直不动，头像是在静止的身体上滑动，这正是纸片感的主要来源。
  // 这里取头部的 1/3 幅度，并做一次较慢的低通，形成"身体慢半拍跟上"的滞后感。
  if (manual.bodyAngleX === undefined) {
    const want = clamp(tgt.angleX * 0.33, -1, 1);
    bodyFollow += (want - bodyFollow) * clamp(4.5 * dt, 0, 1);   // 滞后（比头慢）
    tgt.bodyAngleX = bodyFollow;
  }

  // ---- 参数平滑（指数平滑，帧率无关）----
  // 注意：平滑的是 SMOOTH（纯基础量），派生结果不进这里，
  // 否则派生值会在下一帧被当作输入，形成自反馈漂移。
  for (const k of Object.keys(PARAMS)) {
    if (!(k in tgt)) continue;
    if (manual[k] !== undefined) { SMOOTH[k] = tgt[k]; continue; }
    // 时间常数：眨眼/张嘴要快，姿态可稍慢
    let tau = 0.075;
    if (k === 'eyeLOpen' || k === 'eyeROpen' || k === 'mouthOpen') tau = 0.035;
    else if (k === 'angleY') tau = 0.055;
    else if (k === 'angleX' || k === 'angleZ') tau = 0.070;
    const a = 1 - Math.exp(-dt / tau);
    SMOOTH[k] += (tgt[k] - SMOOTH[k]) * a;
  }

  // 表情权重平滑
  updateExpression(P, dt);

  // 绘制参数 = 平滑后的基础量 + 表情派生量（每帧从 SMOOTH 重算，幂等）
  Object.assign(P, SMOOTH);
  deriveParams(P, SMOOTH, P);

  // ---- 渲染 ----
  renderer.render(P, deformers, {
    scale: renderer.display.scale,
    offsetX: renderer.display.offX,
    offsetY: renderer.display.offY,
  });

  updateHud();
  requestAnimationFrame(frame);
}

/**
 * 表情权重平滑。
 *
 * 重要：这里只负责把 expr* 推向目标值，**不做累加**。
 * 旧实现在这里对 mouthOpen / mouthForm 做 `P.x += ...`，
 * 而它们同时又由主循环按 target 平滑赋值 —— 两个写入者互相拉扯，
 * 每帧被顶高又拉回，表现为嘴部抖动、表情不自然。
 * 派生量现在只在主循环里算一次（见 deriveParams）。
 */
function updateExpression(P, dt) {
  // 指数平滑，与帧率无关
  const approach = (k, want, tau) => {
    const a = 1 - Math.exp(-dt / tau);
    P[k] += (want - P[k]) * a;
  };

  if (fixedExpr) {
    // 固定表情：选中的推到 1，其余回落
    for (const k of ['exprSmile', 'exprLaugh', 'exprBlink', 'exprCalm']) {
      approach(k, k === fixedExpr ? 1 : 0, 0.14);
    }
    return;
  }

  // 自动：由 blendshape 驱动
  approach('exprSmile', clamp(target.exprSmile ?? 0, 0, 1), 0.10);
  approach('exprLaugh', clamp(target.exprLaugh ?? 0, 0, 1), 0.10);
  approach('exprBlink', clamp(target.exprBlink ?? 0, 0, 1), 0.08);
  approach('exprCalm', 0.35, 0.25);
}

/**
 * 由「追踪/手动/待机」的基础量推导出最终绘制参数。
 *
 * 结果写入 BASE（基础量的副本），而不是写回 P。
 * 这样派生是**幂等**的：同一组输入永远得到同一组输出，
 * 不会出现「派生的嘴型又被当作下一帧基础量」的逐帧漂移。
 *
 * @param {object} P     当前表情权重（expr*）
 * @param {object} base  本帧的基础量（已含手动覆盖）
 * @param {object} out   输出对象（会被就地填充）
 */
function deriveParams(P, base, out) {
  // 嘴：在追踪到的开合/嘴型上叠加表情贡献。
  //  取 max 而非相加，避免张嘴时叠加到饱和（之前「张嘴很怪」的原因之一）。
  const laugh = P.exprLaugh;
  out.mouthOpen = clamp(Math.max(base.mouthOpen, laugh * 0.70), 0, 1);
  out.mouthForm = clamp(base.mouthForm * 0.80 + P.exprSmile * 0.50 - P.exprCalm * 0.10, -1, 1);

  // 大笑时眼睛自然眯起（与真实表情一致）
  const squint = laugh * 0.60 + P.exprSmile * 0.18;
  out.eyeLOpen = clamp(base.eyeLOpen * (1 - squint), 0, 1);
  out.eyeROpen = clamp(base.eyeROpen * (1 - squint), 0, 1);
}

let fixedExpr = null;

// ---------------------------------------------------------------------------
function updateHud() {
  const h = $('#hud');
  if (!h) return;
  const t = tracker && tracker.lastResult;
  // 姿态来源诊断：M=姿态矩阵, G=关键点几何
  const dp = tracker && tracker.debugPose;
  const src = dp ? dp.src : '---';
  const raw = dp ? ` [M ${dp.mat.join('/')}  G ${dp.geom.join('/')}]` : '';
  // 姿态超过 ±30° 时限幅（停止继续跟随），在 HUD 上明确标出来
  const cap = dp && dp.capped ? ` <span style="color:#e0a030">限幅${dp.capped} ${dp.deg[0]}°/${dp.deg[1]}°</span>` : '';
  h.innerHTML =
    `FPS <b>${fps.toFixed(0)}</b> &nbsp; ` +
    `face: <b>${t && t.hasFace ? '✓' : '—'}</b> &nbsp; ` +
    `yaw <b>${P.angleX.toFixed(2)}</b> ` +
    `pitch <b>${P.angleY.toFixed(2)}</b> ` +
    `roll <b>${P.angleZ.toFixed(2)}</b> &nbsp; ` +
    `<span style="color:#6c7488">src ${src}${raw}</span>${cap}`;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function buildUI() {
  // 手动滑杆
  const groups = [
    ['头部', ['angleX', 'angleY', 'angleZ']],
    ['眼睛', ['eyeLOpen', 'eyeROpen', 'eyeBallX', 'eyeBallY']],
    ['眉毛', ['browLY', 'browRY', 'browAngle']],
    ['嘴巴', ['mouthOpen', 'mouthForm']],
    ['头发惯性', ['hairSway', 'hairSwayY']],
  ];
  const wrap = $('#sliders');
  for (const [title, keys] of groups) {
    const sec = document.createElement('div');
    sec.className = 'group';
    sec.innerHTML = `<h3>${title}</h3>`;
    for (const k of keys) {
      const p = PARAMS[k];
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = `<span>${k}</span>`;
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = p.min; inp.max = p.max; inp.step = 0.01; inp.value = p.def;
      const val = document.createElement('em');
      val.textContent = p.def.toFixed(2);
      let active = false;
      inp.addEventListener('input', () => {
        manual[k] = parseFloat(inp.value);
        val.textContent = manual[k].toFixed(2);
      });
      inp.addEventListener('dblclick', () => {
        delete manual[k];
        inp.value = p.def; val.textContent = p.def.toFixed(2);
      });
      row.appendChild(inp); row.appendChild(val);
      sec.appendChild(row);
    }
    wrap.appendChild(sec);
  }

  $('#chkTrack').addEventListener('change', (e) => {
    useTracking = e.target.checked;
  });
  $('#chkMesh').addEventListener('change', (e) => {
    renderer.showMesh = e.target.checked;
  });
  $('#chkFlipX').addEventListener('change', (e) => {
    flipX = e.target.checked;
    try { localStorage.setItem('pet.flipX', flipX ? '1' : '0'); } catch (_) {}
  });
  $('#chkFlipY').addEventListener('change', (e) => {
    flipY = e.target.checked;
    try { localStorage.setItem('pet.flipY', flipY ? '1' : '0'); } catch (_) {}
  });
  // 恢复上次的方向设置
  try {
    flipX = localStorage.getItem('pet.flipX') === '1';
    flipY = localStorage.getItem('pet.flipY') === '1';
    $('#chkFlipX').checked = flipX;
    $('#chkFlipY').checked = flipY;
  } catch (_) {}
  $('#btnReset').addEventListener('click', () => {
    manual = {};
    document.querySelectorAll('#sliders input').forEach((i) => {
      const k = i.parentElement.querySelector('span').textContent;
      i.value = PARAMS[k].def;
      i.parentElement.querySelector('em').textContent = PARAMS[k].def.toFixed(2);
    });
  });
  // 残影自检：在用户自己的浏览器里测量跨帧残留
  $('#btnGhost').addEventListener('click', runGhostSelfCheck);

  // ---- 背景图 ----
  $('#btnBg').addEventListener('click', () => $('#fileBg').click());
  $('#fileBg').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadBackgroundFile(f);
    e.target.value = '';           // 允许连续导入同一张
  });
  $('#btnBgClear').addEventListener('click', () => setBackground(null));

  // 拖拽导入：拖到左边画面上即可
  const vp = $('#viewport');
  for (const ev of ['dragenter', 'dragover']) {
    vp.addEventListener(ev, (e) => {
      if (!e.dataTransfer) return;
      // 只在拖的是文件时拦截，避免影响其它拖拽
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      vp.classList.add('drag-over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    vp.addEventListener(ev, (e) => {
      e.preventDefault();
      vp.classList.remove('drag-over');
    });
  }
  vp.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadBackgroundFile(f);
  });

  // ---- 全屏 ----
  $('#btnFull').addEventListener('click', toggleFullscreen);
  // 用 fullscreenchange 同步状态：用户按 Esc 或 F11 退出时也要跟上
  const onFsChange = () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const changed = document.body.classList.contains('fs') !== on;
    document.body.classList.toggle('fs', on);
    if (changed) {
      // 全屏 ⇄ 直播模式联动：全屏时自动收起界面，退出时恢复原状
      const box = $('#chkLive');
      if (on) {
        liveWasOn = box.checked;
        if (!box.checked) { box.checked = true; setLiveMode(true); }
      } else if (!liveWasOn && box.checked) {
        box.checked = false;
        setLiveMode(false);
      }
    }
    applyViewport();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  window.addEventListener('resize', () => {
    // 全屏时跟随窗口尺寸重排（背景依赖画布尺寸铺满）
    if (document.body.classList.contains('fs')) applyViewport();
  });

  // ---- 直播模式 ----
  $('#chkLive').addEventListener('change', (e) => setLiveMode(e.target.checked));
  try {
    if (localStorage.getItem('pet.live') === '1') {
      $('#chkLive').checked = true;
      setLiveMode(true);
    }
    // 恢复上次的背景图
    const savedBg = localStorage.getItem('pet.bg');
    if (savedBg) {
      const img = new Image();
      img.onload = () => { renderer.bgImage = img; document.body.classList.add('has-bg'); };
      img.src = savedBg;
    }
  } catch (_) {}

  // H 切换直播模式；Ctrl/Cmd+S 把当前画面存成 PNG
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
    if (typing) return;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const box = $('#chkLive');
      box.checked = !box.checked;
      setLiveMode(box.checked);
    }
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleFullscreen();
    }
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveFrame();
    }
  });

  // 直播模式下鼠标静止 2 秒就隐藏光标，免得录进画面
  let idleTimer = 0;
  window.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.body.classList.contains('live')) document.body.classList.add('idle');
    }, 2000);
  });

  // 表情预设
  document.querySelectorAll('[data-expr]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.expr;
      fixedExpr = (fixedExpr === v) ? null : v;
      document.querySelectorAll('[data-expr]').forEach((x) =>
        x.classList.toggle('on', x.dataset.expr === fixedExpr));
      if (!fixedExpr && v) { /* auto */ }
      // 应用表情的静态参数
      if (fixedExpr) applyExprPreset(fixedExpr);
      else manual = {};
    });
  });
}

// ---------------------------------------------------------------------------
// 背景图 / 直播模式
// ---------------------------------------------------------------------------

/** 从 File 读入背景图。用 objectURL + Image，避免 base64 撑大内存。 */
function loadBackgroundFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('请选择图片文件（png / jpg / webp）', true);
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    setBackground(img);
    // 记下图片本身，刷新后还能恢复（存的是 data URL，见下）
    try {
      const fr = new FileReader();
      fr.onload = () => {
        try { localStorage.setItem('pet.bg', String(fr.result)); } catch (_) {
          // 图片太大时 localStorage 会超限：背景仍然生效，只是记不住
          setStatus('背景已设置（图片较大，刷新后不会保留）');
        }
      };
      fr.readAsDataURL(file);
    } catch (_) {}
    setStatus('背景已设置');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('这张图片读不出来，换一张试试', true);
  };
  img.src = url;
}

/** 设置或清除背景（传 null 清除） */
function setBackground(img) {
  renderer.bgImage = img;
  document.body.classList.toggle('has-bg', !!img);
  if (!img) {
    try { localStorage.removeItem('pet.bg'); } catch (_) {}
  }
}

/**
 * 直播模式：隐藏一切界面元素，只留皮套和背景。
 * 顺带把网格线关掉 —— 它属于调试界面，不该出现在直播画面里。
 */
let meshBeforeLive = false;
function setLiveMode(on) {
  document.body.classList.toggle('live', on);
  try { localStorage.setItem('pet.live', on ? '1' : '0'); } catch (_) {}
  if (on) {
    meshBeforeLive = renderer.showMesh;
    renderer.showMesh = false;
    document.body.classList.remove('idle');
  } else {
    renderer.showMesh = meshBeforeLive;
    document.body.classList.remove('idle');
  }
  // 直播模式不改画布尺寸：普通模式下画布固定为 SRC（760×900），
  // 输出画幅稳定，窗口大小不影响录制结果。
  // 只有**全屏**才重排画布（见 applyViewport），因为那时要让背景铺满屏幕。
}

/**
 * 按当前模式重排画布与坐标映射。
 *
 * 普通模式：画布 = SRC 的固定尺寸（760×900），窗口大小不影响输出画幅。
 * 全屏模式：画布改成**屏幕的宽高比** —— 这一步很关键：
 *   · 背景图是按 cover 铺满画布的，画布只有跟着屏幕变，背景才能铺满全屏
 *     （否则 760×900 的竖版画布放到 16:9 屏幕上，两侧会留大片黑边）
 *   · 皮套本身仍按比例缩放到屏幕内、居中，不会被拉变形
 */
function applyViewport() {
  const cv = $('#stage');
  if (!cv || !renderer) return;
  const box = renderer.srcBox || { x: 0, y: 0, w: 760, h: 900 };
  const fs = document.body.classList.contains('fs');

  let W = box.w, H = box.h;
  let k = DPR;
  let offX = -box.x * DPR;
  let offY = -box.y * DPR;

  if (fs) {
    W = Math.max(1, window.innerWidth || 1280);
    H = Math.max(1, window.innerHeight || 720);
    // 等比缩放到屏幕内（contain），再居中
    k = Math.min(W / box.w, H / box.h) * DPR;
    offX = (W * DPR - box.w * k) / 2 - box.x * k;
    offY = (H * DPR - box.h * k) / 2 - box.y * k;
  }

  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  renderer.display = { scale: k, offX, offY };
}

/** 进入 / 退出全屏 */
function toggleFullscreen() {
  const vp = $('#viewport');
  if (!vp) return;
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFs) {
    const req = vp.requestFullscreen || vp.webkitRequestFullscreen;
    if (!req) { setStatus('这个浏览器不支持全屏', true); return; }
    // 浏览器要求全屏必须由用户操作直接触发，所以只能在这里调
    Promise.resolve(req.call(vp)).catch((e) => {
      setStatus('全屏失败：' + (e && e.message ? e.message : e), true);
    });
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
  }
}

/** 把当前画面存成 PNG（直播截图 / 录制素材） */
function saveFrame() {
  const cv = $('#stage');
  if (!cv) return;
  try {
    cv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      const t = new Date();
      const pad = (v) => String(v).padStart(2, '0');
      a.download = `皮套_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`
                 + `_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.png`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  } catch (e) {
    setStatus('保存失败：' + (e && e.message ? e.message : e), true);
  }
}

function applyExprPreset(name) {
  manual = {};
  const presets = {
    smile: { mouthOpen: 0.35, mouthForm: 0.85, eyeLOpen: 0.9, eyeROpen: 0.9, browLY: 0.1, browRY: 0.1 },
    laugh: { mouthOpen: 0.85, mouthForm: 1.0, eyeLOpen: 0.06, eyeROpen: 0.06, browLY: 0.5, browRY: 0.5 },
    blink: { mouthOpen: 0.12, mouthForm: 0.35, eyeLOpen: 0.05, eyeROpen: 0.05 },
    calm:  { mouthOpen: 0.05, mouthForm: 0.2, eyeLOpen: 0.95, eyeROpen: 0.95 },
    open:  { mouthOpen: 0.9, mouthForm: 0.5, eyeLOpen: 1, eyeROpen: 1 },
  };
  const p = presets[name];
  if (p) Object.assign(manual, p);
}

// ---------------------------------------------------------------------------
/** 把 getUserMedia 的失败翻译成可执行的修复建议 */
function explainCameraError(e) {
  const name = e && e.name ? e.name : '';
  const tips = {
    NotAllowedError:
      '摄像头权限被拒绝。点地址栏左侧的🔒/ⓘ图标 → 把「摄像头」改为「允许」→ 刷新页面重试。' +
      '若仍不行：Windows 设置 → 隐私和安全性 → 摄像头 → 打开「让桌面应用访问摄像头」。',
    PermissionDeniedError:
      '摄像头权限被拒绝。请在浏览器设置中允许本站访问摄像头后刷新。',
    NotFoundError:
      '没找到摄像头设备。请确认摄像头已连接，且未被其他程序独占。',
    NotReadableError:
      '摄像头被其他程序占用（如钉钉/腾讯会议/相机应用）。关掉它们再重试。',
    OverconstrainedError:
      '摄像头不支持请求的分辨率。可改用默认参数重试。',
    SecurityError:
      '安全限制：必须通过 http://127.0.0.1 或 https 打开，不能用 file:// 直接打开文件。',
  };
  return tips[name] || ('未知错误 ' + name + '：' + (e && e.message ? e.message : e));
}

async function startTracking() {
  if (tracker) return;
  const btn = $('#btnCam');
  if (btn) btn.disabled = true;
  try {
    tracker = new FaceTracker({
      onResult: (r) => { target = r; },
    });
    await tracker.init($('#cam'), setStatus);
  } catch (e) {
    console.error(e);
    const msg = explainCameraError(e);
    setStatus('无法开启摄像头：' + msg);
    // 让用户能完整读到建议
    const box = $('#status');
    if (box) { box.style.borderColor = '#7a3b3b'; box.style.color = '#ffb4b4'; }
    useTracking = false;
    const c = $('#chkTrack'); if (c) c.checked = false;
    tracker = null;               // 允许再次点击重试
    if (btn) { btn.disabled = false; btn.textContent = '重试开启摄像头'; }
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await boot();
  } catch (e) {
    console.error(e);
    setStatus('初始化失败: ' + e.message);
  }
  // 用户点击后才请求摄像头（浏览器要求手势）
  $('#btnCam').addEventListener('click', startTracking);
});
