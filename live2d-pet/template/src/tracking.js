/**
 * tracking.js — 人脸追踪 → 皮套参数
 *
 * 使用 MediaPipe FaceLandmarker：
 *   - faceLandmarks        : 478 个归一化关键点
 *   - faceBlendshapes      : 52 个 ARKit 风格表情系数
 *   - facialTransformationMatrixes : 4x4 头部姿态矩阵
 *
 * 由这三者推导出皮套参数：
 *   头部姿态 -> angleX / angleY / angleZ
 *   虹膜关键点 (468..477) -> eyeBallX / eyeBallY
 *   眼睑 blendshape -> eyeLOpen / eyeROpen
 *   嘴部 blendshape -> mouthOpen / mouthForm
 *   眉毛 blendshape -> browLY / browRY
 *   头部速度 -> hairSway（惯性延迟）
 */

import { FaceLandmarker, FilesetResolver } from '../vendor/vision_bundle.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 从 4x4 矩阵中提取欧拉角（ZXY 分解）。
 *
 * 存储顺序为 **列主序**：元素 (row=r, col=c) 位于 m[c*4 + r]。
 * 该结论不是猜的 —— tools/euler_solve.mjs 用已知旋转矩阵验证过：
 * 列主序下 yaw / pitch / roll 各自 1:1 对应「转头 / 点头 / 歪头」且符号正确；
 * 行主序则三者符号全反。
 *
 * 语义映射：
 *   yaw   → 左右转头（绕竖直轴）
 *   pitch → 上下点头（绕水平轴）
 *   roll  → 左右歪头（绕视线轴）
 *
 * @returns {{yaw:number, pitch:number, roll:number}} 弧度
 */
function eulerFromMatrix(m) {
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const m20 = m[2], m21 = m[6], m22 = m[10];
  const m10 = m[1], m00 = m[0], m11 = m[5], m12 = m[9];

  const yaw = Math.asin(clamp(-m20, -1, 1));
  const cp = Math.cos(yaw);

  let pitch, roll;
  if (Math.abs(cp) > 1e-4) {
    pitch = Math.atan2(m21, m22);
    roll = Math.atan2(m10, m00);
  } else {
    // 万向节锁（真实使用到不了 ±90°，仅保证数值稳定）
    pitch = Math.atan2(-m12, m11);
    roll = 0;
  }
  return { yaw, pitch, roll };
}

export class FaceTracker {
  constructor(opts = {}) {
    this.landmarker = null;
    this.video = null;
    this.running = false;
    this.lastResult = null;
    this.onResult = opts.onResult || (() => {});
    this.smooth = 0.55;
    this._prev = null;
  }

  async init(videoEl, onStatus = () => {}) {
    onStatus('加载 wasm 运行时…');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');

    onStatus('加载人脸模型…');
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: './vendor/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    this.video = videoEl;
    onStatus('请求摄像头…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    videoEl.srcObject = stream;
    videoEl.classList.add('on');          // 让预览可见（CSS: #cam.on）
    await new Promise((res) => {
      if (videoEl.readyState >= 2) return res();
      videoEl.onloadeddata = res;
    });
    await videoEl.play();
    onStatus('追踪中');
    this.running = true;
    this._loop();
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2) {
      const t = performance.now();
      if (this._lastTs !== t) {
        this._lastTs = t;
        try {
          const res = this.landmarker.detectForVideo(v, t);
          this._handle(res);
        } catch (e) {
          console.warn('detect error', e);
          // ⚠ 静默吞掉会让"皮套冻结"这类故障不可见（用户实测踩过）：
          //   首次错误上报到状态栏，之后不再刷屏。
          if (!this._errShown) {
            this._errShown = true;
            try {
              const st = document.getElementById('status');
              if (st) {
                st.textContent = '追踪出错：' + (e && e.message ? e.message : e);
                st.style.color = '#f6ad55';
              }
            } catch (_) {}
          }
        }
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _handle(res) {
    // ⚠ 这里必须**声明全部**后续会赋值的参数。
    //   _handle 末尾的平滑是 S[k] = S[k] + (out[k]-S[k])*a，
    //   若某个键只在后面被赋值、却没在这里初始化为数字，
    //   则首次平滑会得到 undefined + number = NaN，并一路污染表情推导。
    //   （曾漏掉 mouthWide / exprSmile / exprLaugh / exprBlink）
    const out = {
      angleX: 0, angleY: 0, angleZ: 0,
      eyeLOpen: 1, eyeROpen: 1,
      eyeBallX: 0, eyeBallY: 0,
      browLY: 0, browRY: 0, browAngle: 0,
      mouthOpen: 0, mouthForm: 0, mouthWide: 0,
      exprSmile: 0, exprLaugh: 0, exprBlink: 0,
      hasFace: false,
    };

    const hasFace = res.faceLandmarks && res.faceLandmarks.length > 0;
    out.hasFace = !!hasFace;

    if (hasFace) {
      const lm = res.faceLandmarks[0];

      // ---------- 头部姿态 ----------
      //
      // 同时用两种方法估计，再融合：
      //   ① 姿态矩阵（MediaPipe 的 facialTransformationMatrix）
      //   ② 关键点几何（鼻尖相对面部中线/纵向中心的偏移、两眼连线倾角）
      //
      // 为什么必须两种：实测「矩阵法」在很多设备/姿态下输出极小
      // （用户转头时 angleX 只在 0.1 附近），表现就是「扭头皮套不跟着」。
      // 关键点几何虽然精度略低，但**一定随头部转动而响应**，用它兜底/融合
      // 可以保证「转多少、动多少」。
      //
      // 关键点：1=鼻尖, 152=下巴, 10=额顶, 33/263=两侧外眼角, 234/454=两侧脸颊
      const nose = lm[1], chin = lm[152], top = lm[10];
      const eyeOutL = lm[33], eyeOutR = lm[263];
      const cheekL = lm[234], cheekR = lm[454];

      // --- ② 关键点几何估计 ---
      const eyeMidX = (eyeOutL.x + eyeOutR.x) / 2;
      const eyeMidY = (eyeOutL.y + eyeOutR.y) / 2;
      // 尺度：用两眼距（比脸宽更稳，不受头发影响）
      const eyeDist = Math.hypot(eyeOutR.x - eyeOutL.x, eyeOutR.y - eyeOutL.y) + 1e-6;
      const faceH = Math.abs(chin.y - top.y) + 1e-6;

      // yaw：鼻尖偏离两眼中线的程度（转头时鼻尖明显偏向转头方向）
      const yawGeom = (nose.x - eyeMidX) / eyeDist;
      // pitch：鼻尖相对「眼-下巴中点」的纵向偏移
      const midY = (eyeMidY + chin.y) / 2;
      const pitchGeom = (nose.y - midY) / faceH;
      // roll：两眼连线倾角
      const rollGeom = Math.atan2(eyeOutR.y - eyeOutL.y, eyeOutR.x - eyeOutL.x);

      // 归一化：这些几何量的典型满量程约为 ±0.35 / ±0.12 / ±0.5rad
      const geomX = clamp(-yawGeom / 0.30, -1, 1);
      const geomY = clamp(pitchGeom / 0.10, -1, 1);
      const geomZ = clamp(-rollGeom / (22 * Math.PI / 180), -1, 1);

      // --- ① 姿态矩阵估计 ---
      let matX = 0, matY = 0, matZ = 0, haveMat = false;
      if (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length) {
        const mat = res.facialTransformationMatrixes[0].data;
        if (mat && mat.length >= 16) {
          const { yaw, pitch, roll } = eulerFromMatrix(mat);
          // 分辨率：到达 ±1 所需的头部转角（越小越灵敏）
          const YAW_RANGE = 16 * Math.PI / 180;
          const PITCH_RANGE = 15 * Math.PI / 180;
          const ROLL_RANGE = 16 * Math.PI / 180;
          matX = clamp(-yaw / YAW_RANGE, -1, 1);
          matY = clamp(pitch / PITCH_RANGE, -1, 1);
          matZ = clamp(-roll / ROLL_RANGE, -1, 1);
          haveMat = Number.isFinite(matX) && Number.isFinite(matY) && Number.isFinite(matZ);
        }
      }

      // --- 融合 ---
      // 矩阵法在数值可信时权重更高；若它几乎不动（|值|很小）而几何法有明显响应，
      // 就交给几何法主导 —— 这样既保留矩阵法的平滑，又不会「不跟着」。
      const useGeomX = !haveMat || (Math.abs(matX) < 0.15 && Math.abs(geomX) > 0.2);
      const useGeomY = !haveMat || (Math.abs(matY) < 0.15 && Math.abs(geomY) > 0.2);
      const useGeomZ = !haveMat || (Math.abs(matZ) < 0.15 && Math.abs(geomZ) > 0.2);

      let ax = useGeomX ? geomX : clamp(matX * 0.6 + geomX * 0.4, -1, 1);
      let ay2 = useGeomY ? geomY : clamp(matY * 0.6 + geomY * 0.4, -1, 1);
      let az = useGeomZ ? geomZ : clamp(matZ * 0.6 + geomZ * 0.4, -1, 1);

      // ---------- 超出 ±30° 就停止追踪 ----------
      //
      // 单张正面原画只在**小角度**下成立（skill 规则 15）：
      // 超出范围后继续拉伸，只会把脸拉变形、越看越假。
      // 所以这里把头部姿态**限幅在 ±30°**：超过就不再跟随，
      // 模型停在上限处，而不是继续被拉坏。
      //
      // 归一化值 → 角度：YAW_RANGE = 26°，所以 angleX=1 相当于 26°。
      // 直接按「归一化 × 满幅角度」换算出真实角度再限幅，
      // 避免把限幅阈值跟归一化刻度绑死。
      const YAW_DEG = 26, PITCH_DEG = 22, ROLL_DEG = 20;
      const LIMIT_DEG = 30;
      // 点头单独收紧到 16°：大幅点头曾伴随"伸缩脖子/耸肩"类形变观感，
      // 且日常点头很少超过 15°——超过就停止跟踪，模型停在限幅处。
      // （yaw 维持 ±30；roll 是歪头，小角度即可，不另设限。）
      const PITCH_LIMIT_DEG = 16;
      const yawDeg = ax * YAW_DEG;
      const pitchDeg = ay2 * PITCH_DEG;
      const overYaw = Math.abs(yawDeg) > LIMIT_DEG;
      const overPitch = Math.abs(pitchDeg) > PITCH_LIMIT_DEG;
      if (overYaw) ax = clamp(ax, -LIMIT_DEG / YAW_DEG, LIMIT_DEG / YAW_DEG);
      if (overPitch) ay2 = clamp(ay2, -PITCH_LIMIT_DEG / PITCH_DEG, PITCH_LIMIT_DEG / PITCH_DEG);

      out.angleX = ax;
      out.angleY = ay2;
      out.angleZ = az;

      // 诊断信息：显示在 HUD 上便于标定。
      // matX/matY/matZ 本身已经是 -1..1 的归一化值，
      // **不要再乘角度**（之前乘了 16*180/π，显示成 -916.7 这种无意义的数）。
      this.debugPose = {
        mat: [matX, matY, matZ].map((v) => +v.toFixed(2)),
        geom: [geomX, geomY, geomZ].map((v) => +v.toFixed(2)),
        src: (useGeomX ? 'G' : 'M') + (useGeomY ? 'G' : 'M') + (useGeomZ ? 'G' : 'M'),
        deg: [Math.round(yawDeg), Math.round(pitchDeg)],
        capped: (overYaw ? 'X' : '') + (overPitch ? 'Y' : ''),
      };

      // ---------- 虹膜 -> 眼球 ----------
      // 468..472 = 被摄者左虹膜, 473..477 = 被摄者右虹膜
      // 眼皮关键点：被摄者左眼 上睑=159 下睑=145，右眼 上睑=386 下睑=374
      //
      // ⚠ eyeL/eyeR 必须用 `let` 提升到本层作用域：下面的 blendshape 块
      //   也需要它们（几何 EAR 融合）。曾定义在 if 块内、blendshape 块在块外，
      //   earOf(eyeL) 每帧抛 ReferenceError，被检测循环的 try/catch 吞掉，
      //   lastResult 永不更新 → 皮套整个冻结（用户实测"皮套不动了"）。
      let eyeL = null, eyeR = null;
      if (lm.length >= 478) {
        // 每只眼都带上自己的上/下睑关键点，用于算**该眼自己的**高度。
        // 之前左右眼共用 lm[145]/lm[159]（被摄者左眼的上下睑），
        // 导致右眼的俯仰灵敏度用错尺度，两眼转动幅度不一致。
        eyeL = { inner: lm[133], outer: lm[33], up: lm[159], dn: lm[145], iris: lm[473] };
        eyeR = { inner: lm[362], outer: lm[263], up: lm[386], dn: lm[374], iris: lm[468] };

        const gaze = (eye) => {
          if (!eye.iris || !eye.up || !eye.dn) return { x: 0, y: 0 };
          const cx = (eye.inner.x + eye.outer.x) / 2;
          const cy = (eye.up.y + eye.dn.y) / 2;
          const w = Math.abs(eye.outer.x - eye.inner.x) + 1e-6;
          const h = Math.abs(eye.dn.y - eye.up.y) + 1e-6;
          return {
            x: clamp((eye.iris.x - cx) / (w * 0.32), -1, 1),
            y: clamp((eye.iris.y - cy) / (h * 0.9), -1, 1),
          };
        };
        const gL = gaze(eyeL);
        const gR = gaze(eyeR);
        out.eyeBallX = clamp((gL.x + gR.x) / 2, -1, 1);
        out.eyeBallY = clamp((gL.y + gR.y) / 2, -1, 1);
      }

      // 用视线补偿头部旋转，使眼球相对世界保持稳定
      out.eyeBallX = clamp(out.eyeBallX + out.angleX * 0.35, -1, 1);
      out.eyeBallY = clamp(out.eyeBallY + out.angleY * 0.25, -1, 1);

      // ---------- Blendshapes ----------
      if (res.faceBlendshapes && res.faceBlendshapes.length) {
        const bs = {};
        for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
        const g = (k) => bs[k] ?? 0;

        // 注意 MediaPipe 的 *Left/*Right 是"被摄者的左右"，与画面相反
        // 画面上的镜像预览会让它再次翻转，这里按最终观感校正
        const blinkL = g('eyeBlinkLeft');    // 被摄者左眼 = 画面右
        const blinkR = g('eyeBlinkRight');   // 被摄者右眼 = 画面左

        // ---- 几何闭合度（EAR）与 blendshape 取**更强的闭合信号** ----
        // 用户实测：人闭眼了皮套没闭——blendshape 在侧脸/低头/特定光照下
        // 常常低估 eyeBlink（只到 0.4~0.6），眼睛停在半开。
        // EAR = 上下睑距 / 眼宽：睁眼 ≈0.25~0.35，闭眼 ≈0.05。
        // 取 min(开度blend, 开度几何)：哪个说"闭得更实"就听谁的。
        // 无几何（<478 关键点）时 openGeo=1，退回 blendshape 单独决定。
        const earOf = (e) => Math.abs(e.up.y - e.dn.y) / (Math.abs(e.outer.x - e.inner.x) + 1e-6);
        const openGeoL = eyeL ? clamp((earOf(eyeL) - 0.055) / 0.18, 0, 1) : 1;
        const openGeoR = eyeR ? clamp((earOf(eyeR) - 0.055) / 0.18, 0, 1) : 1;
        out.eyeROpen = Math.min(clamp(1 - blinkL * 1.15, 0, 1), openGeoL);  // 角色右眼在画布左侧
        out.eyeLOpen = Math.min(clamp(1 - blinkR * 1.15, 0, 1), openGeoR);

        // 嘴
        const jaw = g('jawOpen');
        const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
        const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
        const pucker = g('mouthPucker');
        const funnel = g('mouthFunnel');
        out.mouthOpen = clamp(jaw * 1.5, 0, 1);
        out.mouthForm = clamp(smile * 1.6 - frown * 1.6 - pucker * 0.4, -1, 1);
        // 嘴型宽窄：微笑拉宽，撅嘴收窄
        out.mouthWide = clamp(smile * 1.2 - (pucker + funnel) * 0.9, -1, 1);

        // 眉
        const bIn = g('browInnerUp');
        const bDownL = g('browDownLeft'), bDownR = g('browDownRight');
        const bOutL = g('browOuterUpLeft'), bOutR = g('browOuterUpRight');
        out.browRY = clamp(bIn * 1.2 + bOutL * 0.8 - bDownR * 1.0, -1, 1);
        out.browLY = clamp(bIn * 1.2 + bOutR * 0.8 - bDownL * 1.0, -1, 1);
        out.browAngle = clamp(bIn * 0.9 - (bDownL + bDownR) * 0.6, -1, 1);

        // 表情推断
        out.exprSmile = clamp(smile * 1.4 + g('cheekSquintLeft') * 0.5, 0, 1);
        out.exprLaugh = clamp(jaw * 1.2 * (smile > 0.25 ? 1 : 0.35), 0, 1);
        out.exprBlink = clamp((blinkL + blinkR) / 2 * 1.3, 0, 1);
      }
    }

    // ---------- 平滑 + 惯性 ----------
    // 用「时间常数」而不是「每帧固定比例」做平滑：
    // 每帧固定比例会让帧率越低越迟钝，而点头（pitch）因为视觉幅度最小，
    // 迟钝感最明显 —— 这正是「上下点头跟不上」的原因。
    const now = performance.now();
    const dt = this._lastTime === undefined ? 1 / 30 : clamp((now - this._lastTime) / 1000, 1 / 240, 0.25);
    this._lastTime = now;

    if (!this._prev) this._prev = { ...out };
    const S = this._prev;

    // 指数平滑：alpha = 1 - exp(-dt / tau)，tau 为时间常数（秒）
    const tauFor = (k) => {
      switch (k) {
        // 需要跟手的：眨眼、张嘴、笑
        case 'eyeLOpen': case 'eyeROpen': case 'mouthOpen':
          return 0.030;
        case 'exprLaugh': case 'exprBlink': case 'exprSmile':
          return 0.060;
        // 头部姿态：pitch 给更小的时间常数（更跟手）
        case 'angleY': return 0.045;
        case 'angleX': return 0.060;
        case 'angleZ': return 0.070;
        // 眼球、眉毛
        case 'eyeBallX': case 'eyeBallY': return 0.045;
        case 'browLY': case 'browRY': case 'browAngle': return 0.070;
        default: return 0.080;
      }
    };

    for (const k of Object.keys(out)) {
      if (k === 'hasFace') continue;
      if (typeof out[k] !== 'number') continue;
      // 防御：S[k] 尚未初始化（新加参数忘了写进 out 的初始值）时直接采用目标值，
      // 而不是拿 undefined 参与运算产生 NaN。
      if (typeof S[k] !== 'number' || !Number.isFinite(S[k])) { S[k] = out[k]; continue; }
      const alpha = 1 - Math.exp(-dt / tauFor(k));
      S[k] = S[k] + (out[k] - S[k]) * alpha;
    }
    S.hasFace = out.hasFace;

    // 头部角速度 -> 头发摆动（物理惯性）
    const nx = S.angleX, ny = S.angleY;
    if (this._lastX === undefined) { this._lastX = nx; this._lastY = ny; }
    // 按真实时间求速度（每秒），而不是按帧
    const vx = (nx - this._lastX) / dt;
    const vy = (ny - this._lastY) / dt;
    this._lastX = nx; this._lastY = ny;

    // 摆动目标：与速度反向（头发被甩在后面）
    this._swayTarget = clamp(-vx * 0.22, -1, 1);
    this._swayTargetY = clamp(-vy * 0.18, -1, 1);
    // 回中（同样按时间）
    const kSway = 1 - Math.exp(-dt / 0.16);
    this._sway = (this._sway ?? 0) + ((this._swayTarget ?? 0) - (this._sway ?? 0)) * kSway;
    this._swayY = (this._swayY ?? 0) + ((this._swayTargetY ?? 0) - (this._swayY ?? 0)) * kSway;
    S.hairSway = clamp(this._sway + S.angleX * 0.12, -1, 1);
    S.hairSwayY = clamp(this._swayY + S.angleY * 0.10, -1, 1);
    // 阻尼回零（按时间）
    const damp = Math.exp(-dt / 0.35);
    this._sway *= damp;
    this._swayY *= damp;

    this.lastResult = S;
    this.onResult(S);
  }

  stop() {
    this.running = false;
    if (this.video && this.video.srcObject) {
      this.video.srcObject.getTracks().forEach((t) => t.stop());
    }
  }
}

export { clamp };
