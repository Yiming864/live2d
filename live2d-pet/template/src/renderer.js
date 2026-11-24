/**
 * renderer.js — 皮套渲染器
 *
 * 渲染管线（每个 ArtMesh）：
 *   1. 取静止顶点 rest[]
 *   2. 按 父→子 顺序依次通过 warpChain 中的每个变形器
 *      —— 这一步实现"分层嵌套的变形器结构"
 *      —— 每个变形器内部使用位置相关的非对称增益
 *   3. 得到形变后的画布坐标
 *   4. 对每个三角形做仿射纹理映射 + 边缘抗锯齿
 *
 * 抗锯齿做法：把贴图先"扩边"（dilate），使采样越过边界时取到邻近颜色
 * 而不是透明黑边，避免三角接缝处的细缝。
 */

import { M, clamp, deformMesh } from './deformer.js';

/**
 * 计算网格/三角形的不透明度。
 *
 * 两类眼睛图层需要淡出：
 *  ① eyewhite / irides —— 闭眼时眼球应消失。
 *     贴图里**同时含左右眼**，所以按三角形所在的那只眼取各自的开合度，
 *     否则单眼眨（wink）会把两只眼一起淡掉。
 *
 *  ② eyelash —— 睫毛贴图是「上睫毛弧 + 下睫毛弧」围成的完整眼形描边。
 *     闭眼时真实的形态是**只剩一条闭合线**（上睫毛），下眼睑那条线应当隐去。
 *     但两条弧在同一张 PNG 里，任何整体位移都无法让它们合并成一条，
 *     只会同时可见（就是"上下睫毛同时存在"）。
 *     因此这里按三角形的**贴图 y** 判断它属于上弧还是下弧，
 *     闭眼时把下弧**淡出**，只留下落下来的上弧 = 一条干净的闭合线。
 *
 * @param {object} mesh
 * @param {object} P
 * @param {number} [texX] 三角形贴图局部 x（像素）
 * @param {number} [texY] 三角形贴图局部 y（像素）
 */
function computeAlpha(mesh, P, texX, texY) {
  const id = mesh.def.id;

  if (id === 'eyelash') {
    // 没有三角形信息时，取整体值
    const opennessOverall = Math.min(P.eyeLOpen, P.eyeROpen);
    if (texY === undefined) return 1;
    const H = mesh.meta.h;
    // 淡出分界取 0.62H —— 比几何分界(0.67H)略高一点。
    // 原因：三角形是按**重心**取值的，若分界正好卡在两弧之间，
    // 跨界的三角形重心仍落在上侧 → 会被整块保留，于是下半部分
    // （下睫毛 + 眼睑皮肤阴影）露出一条痕迹。
    // 上移分界后，上睫毛主体（实测 y=6..30，即 0.12H~0.61H）完整保留，
    // 而下睫毛与皮肤阴影（y≥31）整片淡出。
    const split = H * (mesh.def.lashSplit ?? 0.62);
    // 窄过渡带：避免分界处出现硬边
    const band = H * 0.06;
    if (texY <= split - band) return 1;
    const lower = clamp((split - texY) / band, 0, 1);   // 1=上睫毛, 0=下睫毛
    // 睁眼时下弧完整可见；闭眼时完全隐藏。
    // 最终 alpha = 开合度决定的淡出 × 上下弧的空间权重
    const openFade = clamp(opennessOverall / 0.55, 0, 1);
    return lower + (1 - lower) * openFade;
  }

  // 脖子不再用渐隐（bottomFade）：半透明三角形叠在深色高领上时，
  // 逐三角形绘制的接缝会显形（用户实测"网格带"）。
  // 改用图层顺序：前衣领复制层（topwear_collar + clipRect）盖住脖底。

  if (id !== 'irides' && id !== 'eyewhite') return 1;
  if (texX === undefined) return eyeFade(Math.min(P.eyeLOpen, P.eyeROpen));
  // 贴图左半 = 观者左 = 角色右眼（与 deformer.js 的 EyeWarp 保持一致）
  const isLeftHalf = texX < (mesh.def.splitAt ?? mesh.meta.w / 2);
  return eyeFade(isLeftHalf ? P.eyeROpen : P.eyeLOpen);
}

/** 开合度 → 不透明度：>0.28 全显，<0.10 全隐 */
function eyeFade(openness) {
  return clamp((openness - 0.10) / 0.18, 0, 1);
}

export class Renderer {
  constructor(canvas, ctx2d) {
    this.canvas = canvas;
    this.ctx = ctx2d;
    this.meshes = [];
    this.showMesh = false;
    this.showWarp = false;
    // 背景图（直播/录制用）。null = 透明，由 CSS 的渐变兜底。
    this.bgImage = null;

    // 注意：这里**不再**使用离屏画布。
    //
    // 曾经的做法是「画到离屏 A → 按三角形裁到离屏 B → 合成回主画布」，
    // 三趟 drawImage + 两块跨三角形复用的离屏画布。
    // 实测在真实浏览器中出现 **12.8% 像素的跨帧残留**（用页面上的「残影自检」测出）——
    // 离屏复用是最大嫌疑：任何一次清理不彻底，旧像素都会被合成到主画布。
    //
    // 现在改为「在纹理坐标系里裁剪 + 直绘」（见 _tri），
    // 一趟绘制、无中间缓冲，从根本上消除这类残留。
  }

  addMesh(mesh) { this.meshes.push(mesh); this.meshes.sort((a, b) => a.def.z - b.def.z); }

  /**
   * 主渲染
   * @param {object} P 当前参数值
   * @param {object} D 变形器表
   * @param {object} opts
   */
  render(P, D, opts = {}) {
    const ctx = this.ctx;
    const { w, h } = this.canvas;

    // ---- 真正的 cleardevice() ----
    //
    // 关键认识（由页面上的「残影自检」实测得出）：
    //   确定性 0.000%（同姿态连渲两次完全一致）
    //   但 A→B 与单独渲染 B 差 5.16%，且残留布满整幅画面
    //   ⇒ 渲染 A 会**留下残余的上下文状态**影响随后的 B。
    //
    // 而 `clearRect` **无法**消除这类残留：它受当前**裁剪区**与**变换**支配。
    // 只要上下文里还留着上一次的裁剪路径，clearRect 就只能清到裁剪区内，
    // 裁剪区之外的旧像素原封不动地留下来 —— 表现就是"上一帧还在画面里"。
    //
    // 所以这里改用 Canvas2D 的 `ctx.reset()`：
    // 它把**绘制状态栈、裁剪区、变换、各种样式、以及后备缓冲**一次性复位，
    // 语义上正是 EasyX 的 cleardevice()。
    // 旧浏览器没有该方法时，退回「重设画布尺寸」—— 同样会重置整个上下文。
    if (typeof ctx.reset === 'function') {
      ctx.reset();
    } else {
      const c = this.canvas;
      c.width = w; c.height = h;      // 设尺寸（即使值相同）也会重置上下文并清空
    }
    // 再做一次显式清屏作为双保险（此时已无残留裁剪/变换，必然清到整幅）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);

    // ---- 背景图（直播/录制用）----
    //
    // 在画布坐标系里按 **cover** 方式铺满：等比缩放到刚好盖住画布，再居中裁切。
    // 用 cover 而不是 stretch，是为了任何比例的图都不会被拉变形。
    if (this.bgImage && this.bgImage.complete && this.bgImage.naturalWidth > 0) {
      const iw = this.bgImage.naturalWidth, ih = this.bgImage.naturalHeight;
      const k = Math.max(w / iw, h / ih);
      const dw = iw * k, dh = ih * k;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
      ctx.restore();
    }

    // 全局缩放以适应画布
    const s = opts.scale ?? 1;
    const offX = opts.offsetX ?? 0;
    const offY = opts.offsetY ?? 0;
    ctx.setTransform(s, 0, 0, s, offX, offY);

    for (const mesh of this.meshes) {
      this._deformMesh(mesh, P, D);
      // 整体不透明度（非眼睛图层恒为 1）
      mesh.alpha = computeAlpha(mesh, P);
      // 需要在绘制时逐三角形换算不透明度的图层（见 _drawMesh）：
      //   eyewhite/irides —— 按左右眼分别淡出
      //   eyelash        —— 闭眼时只淡出下睫毛弧，保留上弧作为闭合线
      const id = mesh.def.id;
      mesh.perTriAlpha = (id === 'irides' || id === 'eyewhite' || id === 'eyelash');
    }
    for (const mesh of this.meshes) {
      if (mesh.alpha <= 0.001) continue;
      this._drawMesh(mesh, opts, P);
    }

    if (this.showMesh) this._drawMeshWireframe(opts);
  }

  /**
   * 把静止顶点依次通过变形器链，得到最终位置。
   *
   * 实现已抽到 deformer.js 的 `deformMesh()` —— 渲染与测试共用同一份代码。
   * 之前这里和各个测试脚本各写了一份变形循环，改了渲染逻辑而测试还跑旧逻辑，
   * 测出来的东西与线上行为不一致（加 rigid 时就踩到了）。
   */
  _deformMesh(mesh, P, D) {
    deformMesh(mesh, P, D);
  }

  /** 用仿射变换逐三角形绘制贴图（直接裁剪直绘，无离屏缓冲） */
  _drawMesh(mesh, opts, P) {
    const ctx = this.ctx;
    // ---- clipRect：本层只在矩形区域内绘制（画布坐标）----
    //
    // 用于「前衣领」复制层（topwear_collar）：同一张贴图画两遍，
    // 下层（z 更小）是身体+后领，被脖子压住；本层裁剪出前领带，
    // 盖住脖子下端——等效于把 see-through 合在一起的前后领拆成两层。
    // 两份变形链完全一致 ⇒ 重叠区像素相同 ⇒ 裁剪边缘无缝。
    const hasClip = !!mesh.def.clipRect;
    if (hasClip) {
      const r = mesh.def.clipRect;
      ctx.save();
      ctx.beginPath();
      // 用 moveTo/lineTo 而不是 ctx.rect——部分软件画布 shim 只实现了
      // 基本路径指令（_tri 的裁剪也只用 moveTo/lineTo），rect 会缺方法。
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x + r.w, r.y);
      ctx.lineTo(r.x + r.w, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.closePath();
      ctx.clip();
    }
    const img = mesh.image;
    const cols = mesh.cols, rows = mesh.rows;
    const W = mesh.meta.w;
    const H = mesh.meta.h;
    // 逐三角形取不透明度：眼睛/睫毛图层的淡出边界是**斜向或水平**的，
    // 若按四边形统一取值，跨边界的四边形会整块淡出，边缘呈阶梯状。
    const drawTri = (a, b, c) => {
      if (mesh.perTriAlpha && P) {
        // 用三角形重心在贴图上的位置判定它属于哪只眼 / 上弧还是下弧
        const texX = (mesh.uv[a][0] + mesh.uv[b][0] + mesh.uv[c][0]) / 3 * W;
        const texY = (mesh.uv[a][1] + mesh.uv[b][1] + mesh.uv[c][1]) / 3 * H;
        ctx.globalAlpha = computeAlpha(mesh, P, texX, texY);
        if (ctx.globalAlpha <= 0.001) return;
      } else {
        ctx.globalAlpha = mesh.alpha ?? 1;
      }
      this._tri(ctx, mesh, a, b, c, img);
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = mesh.idx(c, r), i1 = mesh.idx(c + 1, r);
        const i2 = mesh.idx(c, r + 1), i3 = mesh.idx(c + 1, r + 1);
        drawTri(i0, i1, i2);
        drawTri(i1, i3, i2);
      }
    }
    if (hasClip) ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * 单个三角形的仿射纹理映射 —— **直接裁剪 + 直绘**，不使用离屏画布。
   *
   * 为什么去掉离屏：之前每个三角形都要「画到离屏 A → 裁到离屏 B → 合成回主画布」，
   * 三趟 drawImage 加两块跨三角形复用的离屏画布。实测在真实浏览器里
   * 出现 12.8% 像素的跨帧残留（用户用自检按钮测出），而离屏复用正是最大嫌疑：
   * 只要任何一次清理不彻底，上一个三角形/上一帧的像素就会被合成到主画布上。
   *
   * 现在改成：在**纹理坐标系**里建立裁剪路径（与 m 同一坐标系），
   * 裁剪后直接把贴图的对应子块画上去。一趟绘制、无中间缓冲，
   * 从根本上不存在"残留在离屏里"的可能。
   */
  _tri(ctx, mesh, a, b, c, img) {
    const p0 = mesh.pos[a], p1 = mesh.pos[b], p2 = mesh.pos[c];
    const t0 = mesh.uv[a], t1 = mesh.uv[b], t2 = mesh.uv[c];

    const W = mesh.meta.w, H = mesh.meta.h;
    // 纹理空间坐标（像素）
    const x0 = t0[0] * W, y0 = t0[1] * H;
    const x1 = t1[0] * W, y1 = t1[1] * H;
    const x2 = t2[0] * W, y2 = t2[1] * H;

    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(det) < 1e-9) return;

    // 目标三角形退化则跳过
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 0.02) return;

    // 从 (纹理) -> (屏幕) 的仿射矩阵
    const m = [
      ((p1[0] - p0[0]) * (y2 - y0) - (p2[0] - p0[0]) * (y1 - y0)) / det,
      ((p1[1] - p0[1]) * (y2 - y0) - (p2[1] - p0[1]) * (y1 - y0)) / det,
      ((p2[0] - p0[0]) * (x1 - x0) - (p1[0] - p0[0]) * (x2 - x0)) / det,
      ((p2[1] - p0[1]) * (x1 - x0) - (p1[1] - p0[1]) * (x2 - x0)) / det,
      0, 0,
    ];
    m[4] = p0[0] - (m[0] * x0 + m[2] * y0);
    m[5] = p0[1] - (m[1] * x0 + m[3] * y0);

    // 源块范围（略微外扩 1px，避免采样到贴图边缘时出现透明细缝）
    const PAD = 1;
    const sx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - PAD);
    const sy0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - PAD);
    const sx1 = Math.min(W, Math.ceil(Math.max(x0, x1, x2)) + PAD);
    const sy1 = Math.min(H, Math.ceil(Math.max(y0, y1, y2)) + PAD);
    const sw = sx1 - sx0, sh = sy1 - sy0;
    if (sw <= 0 || sh <= 0) return;

    // 用 try/finally 包住 save/restore：
    // 只要 drawImage 因任何原因抛异常，restore 仍会执行。
    // 否则**裁剪区会泄漏到后续所有绘制**——此后 clearRect 只能清到裁剪区内，
    // 上一帧的像素就永远留在画面上（这正是"残影"的机制）。
    ctx.save();
    try {
      // 切到纹理坐标系：此后裁剪路径与贴图都在同一空间里，语义一致
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

      // ---- 裁剪三角形向外扩 ~0.6 纹理像素 ----
      //
      // 用户实测：点头时脸上/脖子出现"三角形的线"。
      // 机制：相邻三角形共享一条边，各自按精确多边形裁剪，每边只画到
      // 半像素覆盖；两个半像素在抗锯齿相位错开时合不成完全不透明 →
      // 沿网格边露出发丝缝，运动时相位逐帧变化，缝就成了可见的三角形网。
      //
      // 对策（经典做法）：把裁剪三角形绕质心向外膨胀一点点，
      // 让相邻三角形沿共享边**互相重叠**约 1 像素。重叠是安全的——
      // 每个三角形画的都是自己连续的贴图，共享边两侧颜色一致，
      // 叠起来恰好补满缝隙，而不会产生错位。
      const gx = (x0 + x1 + x2) / 3, gy = (y0 + y1 + y2) / 3;
      const d0 = Math.hypot(x0 - gx, y0 - gy);
      const d1 = Math.hypot(x1 - gx, y1 - gy);
      const d2 = Math.hypot(x2 - gx, y2 - gy);
      const dmin = Math.min(d0, d1, d2) || 1;
      const k = Math.min(1 + 0.6 / dmin, 1.35);   // 最近顶点保证外扩 0.6px
      const ex = (x) => gx + (x - gx) * k;
      const ey = (y) => gy + (y - gy) * k;

      ctx.beginPath();
      ctx.moveTo(ex(x0), ey(y0));
      ctx.lineTo(ex(x1), ey(y1));
      ctx.lineTo(ex(x2), ey(y2));
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, sx0, sy0, sw, sh, sx0, sy0, sw, sh);
    } finally {
      ctx.restore();
    }
  }

  /** 调试：绘制网格线 */
  _drawMeshWireframe(opts) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = 'rgba(0,200,255,0.55)';
    for (const mesh of this.meshes) {
      const { cols, rows } = mesh;
      ctx.beginPath();
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          const p = mesh.pos[mesh.idx(c, r)];
          if (c === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
      }
      for (let c = 0; c <= cols; c++) {
        for (let r = 0; r <= rows; r++) {
          const p = mesh.pos[mesh.idx(c, r)];
          if (r === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
