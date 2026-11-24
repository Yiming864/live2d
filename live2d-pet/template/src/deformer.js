/**
 * deformer.js — 网格变形器引擎
 *
 * 核心思想（与 Live2D Cubism 一致）：
 *
 *   ArtMesh 顶点 (局部坐标)
 *        │  ① 静态绑定：顶点在网格创建时记录"到各变形器的权重"
 *        ▼
 *   按 父→子 顺序依次通过每个变形器
 *        │  ② 每个变形器把输入点映射到输出点 (f: R² → R²)
 *        ▼
 *   画布坐标 → 使用三角剖分 + 仿射贴图绘制
 *
 * 为什么需要"非对称顶点位移"：
 *   单纯的刚体旋转 (绕枢轴转角度) 会让整张脸像纸片一样翻转，很假。
 *   真实转头时：
 *     - 靠近枢轴的一侧几乎不动
 *     - 远离枢轴的一侧位移更大
 *     - 侧面的头发/耳朵还会因为被遮挡而产生额外形变
 *   所以我们对每个顶点用 **位置相关的位移增益** g(v)，
 *   并且左右两侧使用不同的增益表，使转头时左右表现不同。
 */

/** 2D 仿射矩阵工具（行主序 2x3: [a,b,c,d,tx,ty]） */
export const M = {
  identity: () => [1, 0, 0, 1, 0, 0],
  apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },
  mul(a, b) {
    // 返回 a ∘ b （先 b 后 a）
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  },
  invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return M.identity();
    const id = 1 / det;
    return [
      m[3] * id, -m[1] * id,
      -m[2] * id, m[0] * id,
      (m[2] * m[5] - m[3] * m[4]) * id,
      (m[1] * m[4] - m[0] * m[5]) * id,
    ];
  },
  fromTranslate(tx, ty) { return [1, 0, 0, 1, tx, ty]; },
  fromScale(sx, sy = sx) { return [sx, 0, 0, sy, 0, 0]; },
  fromRotate(r) {
    const c = Math.cos(r), s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
  },
  /** 绕点 (px,py) 旋转 r 弧度 */
  rotateAround(r, px, py) {
    return M.mul(M.fromTranslate(px, py), M.mul(M.fromRotate(r), M.fromTranslate(-px, -py)));
  },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * ArtMesh：把一张贴图切成 cols×rows 的顶点网格
 * 每个顶点保留原始的 (u,v) 纹理坐标与画布局部坐标 (x,y)
 */
export class ArtMesh {
  constructor(def, meta, image) {
    this.def = def;
    this.meta = meta;
    this.image = image;
    const { cols, rows } = def.mesh;
    this.cols = cols;
    this.rows = rows;
    const w = meta.w, h = meta.h;

    this.rest = [];   // 静止位置（贴图局部像素坐标）
    this.uv = [];     // 纹理坐标（0..1）
    this.pos = [];    // 当前形变后位置（画布坐标）

    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const u = c / cols, v = r / rows;
        const lx = u * w, ly = v * h;
        this.rest.push([lx, ly]);
        this.uv.push([u, v]);
        this.pos.push([meta.x + lx, meta.y + ly]);
      }
    }
    this.idx = (c, r) => r * (cols + 1) + c;

    // 三角形索引
    this.tris = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = this.idx(c, r), b = this.idx(c + 1, r);
        const d = this.idx(c, r + 1), e = this.idx(c + 1, r + 1);
        this.tris.push([a, b, d], [b, e, d]);
      }
    }

    // 每个顶点的"侧别"权重：用于非对称位移
    //   sideL: 该顶点属于角色左侧的程度 (0..1)
    //   sideR: 角色右侧的程度
    this.sideL = [];
    this.sideR = [];
    const cx = w / 2;
    for (const [lx] of this.rest) {
      // 用相对网格中心的横向位置决定左右权重
      // 注意：贴图本身可能不居中（如 eyewhite 覆盖双眼），用 meta 的画布中心校正
      const canvasX = meta.x + lx;
      const t = clamp((canvasX - 512) / (w / 2 + 1e-6), -1, 1);
      // t<0 -> 画布左侧 -> 观者左 -> 角色右
      this.sideL.push(clamp(-t, 0, 1));
      this.sideR.push(clamp(t, 0, 1));
    }

    // 距离度：0=靠近枢轴，1=远离枢轴（用于视差增益）
    this.pivotDist = [];
    for (const [lx, ly] of this.rest) {
      const px = meta.x + lx - 512, py = meta.y + ly - 470;
      const d = Math.hypot(px, py) / 420;
      this.pivotDist.push(clamp(d, 0, 1.6));
    }
  }
}

/**
 * 变形器：一个把点从输入空间映射到输出空间的函数对象。
 * 所有变形器共用接口: apply(x, y, ctx) -> [x, y]
 * ctx 提供当前参数、该顶点的侧别权重与距离权重。
 */
export class Deformer {
  constructor(id, fn) {
    this.id = id;
    this.fn = fn;
  }
  apply(x, y, ctx) { return this.fn(x, y, ctx); }
}

/**
 * 构建所有变形器。
 *
 * 每个变形器都遵循同样的"非对称"原则：
 *   位移量 = 基础位移 × 侧别增益(sideL/sideR) × 距离增益(pivotDist)
 * 左右两侧的增益通过 rig 里的 asymmetric / 参数符号区分，因此结果不对称。
 */
export function buildDeformers(P, ANGLE_SCALE, HEAD_PIVOT) {
  const D = {};

  // ---- 根 / 身体 ----
  //
  // 躯干按**圆柱**转（Live2D 的标准做法，见 skill 规则 20）：
  //   · 腰以下不动（下摆固定）
  //   · 越往上（肩、胸）跟得越多
  //   · 同时有一点点横向位移，像是在绕身体中轴转
  //
  // 为什么必须让身体参与：之前头横向移 52px、还压扁 22%，
  // 而身体几乎不动（衣领 15.7px、下摆 1.4px）——
  // 观感就是"一张会变形的头在静止的身体上滑来滑去"，这正是纸片感的来源。
  // 让整个身躯跟着转，头才不会显得是贴上去的。
  D.BodyWarp = new Deformer('BodyWarp', (x, y, c) => {
    const bx = P.bodyAngleX;
    const br = P.breath;

    // 圆柱权重：下摆（y≈1000）为 0，肩部（y≈400）为 1
    const up = clamp((900 - y) / 500, 0, 1);
    const bodyW = up * up * (3 - 2 * up);          // smoothstep，过渡更自然

    // 横向位移 + 轻微横向挤压（圆柱转动的投影）
    let nx = x + bx * 30 * bodyW;
    nx = 512 + (nx - 512) * (1 - Math.abs(bx) * 0.05 * bodyW);

    // 呼吸：胸腔部（下方）起伏更大
    const ny = y + br * 7 * (0.4 + 0.6 * clamp((y - 400) / 600, 0, 1));
    return [nx, ny];
  });

  // ---- 头部整体 ----
  D.HeadWarp = new Deformer('HeadWarp', (x, y, c) => {
    const yaw = P.angleX * ANGLE_SCALE.yaw;
    const pitch = P.angleY * ANGLE_SCALE.pitch;
    const roll = P.angleZ * ANGLE_SCALE.roll;

    // ① 头部姿态
    //
    // ⚠ 核心原则：**只做位移，不做缩放**。
    //   之前用 `ox / depth`（yaw）和 `ny /= (...)`（pitch）对整个头部做压缩，
    //   结果是整张脸连同五官被压扁/压窄 —— 这就是「脸的轮廓变形」「低头时头被
    //   纵向压缩」的原因。头部刚性转动时，轮廓不应改变形状，只应平移。
    //
    //   所以改为：**每个顶点按其在头上的高度/横向位置获得不同的位移量**，
    //   位移场是平滑变化的，但任何局部都不被拉伸或压缩。
    let ox = x - HEAD_PIVOT.x, oy = y - HEAD_PIVOT.y;

    // 归一化坐标：oxN ∈ [-1,1]（横向，0=中轴），oyN ∈ [-1,1]（纵向，>0=上方）
    const oxN = clamp(ox / 200, -1, 1);
    const oyN = clamp(-oy / 260, -1, 1);

    // ---- yaw（左右转头）：非对称位移（近大远小）----
    //
    // 几何推导（务必按这个来，方向搞反会看起来"朝反方向转头"）：
    //   设头绕竖直轴旋转、鼻尖朝画面右侧偏（即 yawAmt > 0）
    //     · 画面**右侧**脸颊（+X）转**离**相机 → 透视上变窄 = 远侧 = 变小
    //     · 画面**左侧**脸颊（-X）转**向**相机 → 透视上几乎不变 = 近侧 = 变大
    //   所以：**远侧 = 与鼻子指向相同的那一侧**。
    //
    //   ⚠ 之前写成「同侧为近侧」，等于把远侧当成近侧，做成了"远大近小"，
    //     观感就是"朝反方向扭头"。此处的符号必须与上面推导一致。
    const yawAmt = clamp(yaw / ANGLE_SCALE.yaw, -1, 1);
    const ay = Math.abs(yawAmt);

    const isRightHalf = ox >= 0;
    // 鼻子指向：yawAmt > 0 → 画面右侧
    const noseToRight = yawAmt >= 0;
    // 远侧 = 与鼻子指向同侧；近侧 = 另一侧
    const isFar = (noseToRight === isRightHalf);

    // 挤压强度：远侧内收、近侧几乎不动。
    //
    // 取值历经三轮用户实测：
    //   0.22 → "横向过度压缩"；0.13 → "眼睛嘴的大小变化没了"；
    //   0.19 → 又嫌"左右转头时脸轮廓变化"偏大。
    // 定在 **0.16**：轮廓变化比 0.19 小约 1/5，五官仍有 ~6% 的可见尺寸变化。
    const squeezeFar = 0.16;    // 远侧内收
    const squeezeNear = 0.01;   // 近侧几乎不动

    // ---- 但**颅顶不能跟着压这么多** ----
    // 用户指出的"纸片感"其实是：**头颅被压扁得太夸张**。
    // 几何上是对的 —— 头骨接近**球体**，转动时轮廓几乎不变；
    // 会明显透视缩短的是**脸**（较平、五官所在的那一面）。
    // 所以让挤压强度按高度衰减：脸部给满，颅顶/头顶只给一小部分。
    //   y ≈ 120（头顶）→ 0.25 倍      y ≥ 330（脸部）→ 1.0 倍
    const craniumFade = clamp((y - 120) / 210, 0.25, 1);
    const sq = 1 - ay * (isFar ? squeezeFar : squeezeNear) * craniumFade;

    // 注意：nx 是**相对枢轴的偏移量**（由 ox 而来），不是绝对画布坐标。
    // 所有对 nx 的缩放/平移都必须在这个"偏移空间"里做，
    // 绝对坐标只在最后的 return 里加回 HEAD_PIVOT。
    let nx = ox * sq;

    // ---- 五官的深度差：**大幅收敛**（用户反馈"五官没有跟着脸动"）----
    //
    // 物理上，凸出的部位在转头时确实会多挪一点（x' = x·cosθ + d·sinθ 中的 d·sinθ）。
    // 但上一版给到 ±14px，效果是五官**相对脸明显移位** ——
    // 鼻子离开脸的中轴、虹膜相对眼眶滑开，看上去就是"五官没跟着脸走"。
    //
    // 参考 Live2D 的做法（rigid 参数）：五官应当**跟着面部曲面走**，
    // 只是其自身的**内部形变**比曲面小一些（显得更"硬"），
    // 而**不是相对曲面平移**。所以这里把横向偏移降到很小的量级，
    // 只保留一点点层次感（3px 以内，肉眼不会觉得脱离）。
    // 结论：这项直接**置零**。
    //   理由：±2.5px 时它已经低于其他变形器（EyeWarp/MouthWarp 自带 angleX 项）
    //   造成的位移量级，既看不出层次感，又仍然让五官相对脸产生偏移 ——
    //   一个"没有可见收益、却保留副作用"的参数，不如去掉。
    //   `yawDepth` 仍留在 rig.js 里作为记录；若将来要做 Live2D 的 rigid 效果
    //   （五官跟着曲面走、但自身内部形变更小），应当改的是"内部形变比例"，
    //   而不是"相对曲面平移"。
    const depth = c.def.yawDepth ?? 0;
    nx += yawAmt * depth * 0;

    // 整体平移：让"头转向哪边就朝哪边挪"，产生明确的转向。
    //
    // ⚠ 行程 34 而不是 52：rigkit 标定 yaw_px=38（1254 画布）→ 1024 约 31px。
    //   52px 时脸（389..629）滑出脖子的覆盖范围——脖子左上角(431,338)在
    //   满幅摇头时露出来，用户实测"脑袋跟脖子脱节"。
    //   34px：脸左缘 443 仍盖住脖角 431（12px 余量），且配合 0.16 的
    //   远侧内收，转头感依然明确。
    nx += yawAmt * 34;
    // ⚠ 这里**不加**线性斜切项（形如 yawAmt * k * oxN）。
    //   实测过：它会让"左转"和"右转"的总宽度变化差很多
    //   （左转 -8.1% vs 右转 -0.9%），因为该项在一侧扩张、另一侧收缩，
    //   叠加到非对称挤压上后两侧不再对称。去掉后两个方向都稳定。

    // ---- pitch（上下点头）----
    //
    // 用户反馈：「抬头时脸会被拉长，低头时会被压缩」—— 根因就是这里的**梯度**。
    // 只要纵向位移随高度变化（梯度 ≠ 0），就是在纵向拉伸/压缩这张脸；
    // 之前用 (0.62 + 0.35·oyN)，脸部上下端差 0.35，
    // 抬头时头顶比下巴多走 30×0.35 ≈ 10px → 脸被抻长。
    //
    // 正确做法（与 Live2D 一致）：**脸部范围内位移场恒定**，
    // 也就是整块头上下平移、完全不变形；把过渡交给脖子去吸收
    // （脖子的 HeadWarp 权重本来就是沿高度渐变的，见 rig.js）。
    // 脸椭圆**之外**（外圈头发）再给一点反向位移，
    // 制造"头在头发里移动"的层次，而不是整团一起动。
    const pitchAmt = clamp(pitch / ANGLE_SCALE.pitch, -1, 1);
    let ny = oy;
    {
      // ---- 俯仰位移场：rigkit pitch_profile 同构的**穹顶场**（不是平移）----
      //
      // 用户实测：纯平移时"头没有变化、只伸缩脖子"。官方教程要求 Y 关键形
      // "按透视画、远侧略收窄"——头本身必须形变：
      //   · 脸中心位移最大（Q≈1.0），向轮廓衰减（额侧 0.45 / 下颌侧 0.60）
      //     ⇒ 五官领先于轮廓 ⇒ 可见的透视缩短（点头时脸"缩"一点）
      //   · 椭圆外缓慢过渡到 back（顶部/底部为负）⇒ 发梢轻微反推（滞后）
      //
      // ⚠ 椭圆必须**贴合脸部**（半轴 ≈ 脸半轴×1.05），不能用之前为"纯平移"
      //   放大的 180/235——那会让整张脸都处在 dome≈1 的平台里，头又不动了。
      // ⚠ 椭圆外的衰减带 r_sil=2.0（rigkit 同值）：脸颊角（r≈1.1）只比轮廓
      //   略低，不会翻负——之前"脸上三角形线"的教训（场在脸上翻负=剪切）。
      //
      // 验证（标准品数值）：抬头满幅——脸顶 +12.5、下巴 +13.9（高度 +0.4%），
      // 眼/鼻 +24（领先 11px）⇒ 头动、轮廓稳、五官领先。
      const pdy = (y - 305) / 167;                 // 相对脸中心，下正上负
      const sn = -pdy;                             // rigkit 约定：上为正
      const cn = (x - 512) / 126;
      const prr = Math.hypot(cn, pdy);
      const edge = 0.38 + 0.22 * Math.max(0, -sn) + 0.07 * Math.max(0, sn);
      const back = 0.1 * cn * cn - 0.35 * Math.max(0, -sn) ** 2 - 0.12 * Math.max(0, sn) ** 2;
      let Q;
      if (prr <= 1) {
        Q = edge + (1 - edge) * (1 - prr ** 3);            // 穹顶
      } else {
        const t = clamp((prr - 1) / 2.0, 0, 1);            // r_sil = 2.0
        const sT = t * t * (3 - 2 * t);
        Q = edge + (back - edge) * sT;
      }
      // 行程上下不对称（标定抬头 22.5 / 低头 16 ≈ 1.4 → 24/18）：
      // 低头时脸被遮挡的部分更多，行程更小。
      // pitchGain：点头不传给躯干（topwear 0.08 不耸肩；neck 0.45 下颌滑动
      // 藏在脸下、脖底始终在前衣领裁剪带内）。
      ny += pitchAmt * (pitchAmt > 0 ? 18 : 24) * Q * (c.def.pitchGain ?? 1);
    }
    // 注意：这里**不再**加 `depth * 5.0` 那样的"深度纵向差"——
    // 那会让五官之间产生相对位移，与"锁死五官相对距离"的要求直接冲突。

    // ---- 点头**不做任何旋转** ----
    //
    // 曾经在 pitch 时叠过一个 3.4° 的小倾斜，实测是"抬头拉长、低头压缩"
    // 与"五官相对距离被改变"的**主因**：
    //   旋转 3.4° 会把 314px 高的脸的包围盒高度改变约 6%，
    //   细长部件（眉毛只有 19px 高）的纵向跨度甚至变化 20%+，
    //   鼻-嘴距离也会被拉大 20% 以上 —— 正是用户指出的两个现象。
    //
    // Live2D 的做法（rigkit 的 surface.py）里 pitch 是**纯纵向位移场**，
    // 没有任何旋转项。所以这里也去掉：点头 = 整块头上下平移，
    // 过渡交给脖子（它的 HeadWarp 权重本来就是沿高度渐变的）。

    // 图层视差不用在这里做：变形器链上的**权重**天然就是视差手段 ——
    // 后发 / 衣领取小于 1 的 HeadWarp 权重，位移略小，与脸层错开，
    // 转头时才不像是"整张纸片在平移"。见 rig.js 里各图层的 warpChain。

    // ---- 头发外轮廓反向移动（skill 的 silhouette）----
    //
    // 脸椭圆形**之外**的头发，随转头**朝相反方向**轻微移动。
    // 这是很有力的立体线索：头在头发里"转动"，外层发梢相对滞后，
    // 于是轮廓不再是整块平移 —— 单纯让所有头发跟头同向走，
    // 外轮廓就是一张纸在滑。
    //
    // 用**变形前**的坐标判断远近，避免边算边改导致判定抖动。
    {
      const FCX = 512, FCY = 305;         // 脸椭圆中心（实测脸层范围的中位）
      const FRX = 132, FRY = 168;         // 脸椭圆半径（到额头/下巴）
      const rr = Math.hypot((x - FCX) / FRX, (y - FCY) / FRY);
      if (rr > 1) {
        const out = clamp((rr - 1) / 0.9, 0, 1);   // 越往外权重越大
        nx -= yawAmt * 13 * out;                   // 反向：与脸的运动相反
      }
    }

    // ---- yawGain：偏航位移的逐层闸门 ----
    //
    // 两种形式：
    //   · 数值：整层统一缩放（topwear 0.1 等）
    //   · 函数 (x,y,c)=>0..1：沿高度渐变——脖子用它实现"顶部跟头、
    //     根部锚在躯干上"的弯曲（用户实测：全 0 会"脑袋跟脖子脱节"，
    //     全跟会"脖子根部动"——脖子需要的是**弯**，不是**滑**）。
    // roll（歪头）不经过此闸门：头+脖一起刚体倾斜是正确的。
    const ygRaw = c.def.yawGain ?? 1;
    const yawGain = (typeof ygRaw === 'function')
      ? clamp(ygRaw(x, y, c), 0, 1)
      : ygRaw;
    if (yawGain !== 1) nx = ox + (nx - ox) * yawGain;

    // roll：真正的旋转（歪头）
    if (roll !== 0) {
      const ca = Math.cos(roll), sa = Math.sin(roll);
      const rx = nx * ca - ny * sa;
      const ry = nx * sa + ny * ca;
      nx = rx; ny = ry;
    }

    return [nx + HEAD_PIVOT.x, ny + HEAD_PIVOT.y];
  });

  // ---- 头发摆动（前/后分离，非对称） ----
  const hairFn = (id, gainScale, delay) => new Deformer(id, (x, y, c) => {
    // 垂直位置：越靠下发梢摆动越大
    const ty = clamp((y - 100) / 350, 0, 1);
    const sway = P.hairSway * gainScale * (0.25 + 0.75 * ty) * (1 - delay * 0.35);
    const swayY = P.hairSwayY * gainScale * 0.5 * ty;

    // 非对称：左右两侧使用不同增益表
    const asym = c.def.asymmetric;
    let sideGain;
    if (asym) {
      sideGain = lerp(asym.L, asym.R, clamp(0.5 + (x - 512) / 500, 0, 1));
    } else {
      sideGain = 1;
    }
    // 远离枢轴一侧摆动更大
    const distGain = 0.5 + 0.7 * c.pivotDist;
    return [
      x + sway * sideGain * distGain * 26,
      y + swayY * sideGain * 10,
    ];
  });

  // ⚠ 前发与后发的**摆幅增益必须一致**（只允许"延迟"不同）。
  //   之前给前发 1.15、后发 0.85，两者摆幅相差 35%，
  //   运动时前后发相互错开（实测最大 6.1px）——后发原本被前发遮住的部分会露出来，
  //   看起来像「两道重叠的头发轮廓」。
  //   真实头发前后层是连在一起摆动的，摆幅应相同，后发只是因惯性略滞后。
  D.HairSwayFront = hairFn('HairSwayFront', 1.0, P.__delayFront ?? 0.2);
  D.HairSwayBack = hairFn('HairSwayBack', 1.0, 0.45);

  // ---- 脸部（表情形变）----
  D.FaceWarp = new Deformer('FaceWarp', (x, y, c) => {
    const cx = 512, cy = 330;   // 脸部中心
    let ox = x - cx, oy = y - cy;
    let sx = 1, sy = 1, tx = 0, ty = 0;

    // 微笑：脸颊横向拉宽、下巴上提
    const smile = P.exprSmile;
    sx += smile * 0.030 * clamp(oy / 150, -0.4, 1.2);
    ty -= smile * 5 * clamp((oy + 140) / 200, 0, 1);

    // 大笑：整体上提、下颌张开
    const laugh = P.exprLaugh;
    ty -= laugh * 9 * clamp((oy + 140) / 220, 0, 1);
    sy += laugh * 0.035;

    // 平静/闭眼微笑：面部略放松
    const calm = P.exprCalm;
    sy -= calm * 0.012;

    // 嘴部张开带动下颌
    const mo = P.mouthOpen;
    ty += mo * 6 * clamp((oy - 20) / 130, 0, 1);

    // 转头时的横向跟随位移。
    // ⚠ 这里**不做** `sx *= 1 + angleX * k` 这种按转向方向的横向缩放：
    //   那会让左转与右转的宽度变化不对称（一个放大、一个缩小），
    //   与非对称挤压叠加后两个方向表现不一致（实测 -8.1% vs -0.9%）。
    //   转头的形状变化统一由 HeadWarp 的非对称挤压负责。
    tx += P.angleX * 4 * (1 - c.pivotDist * 0.3);

    return [cx + ox * sx + tx, cy + oy * sy + ty];
  });

  // ---- 眼睛：开合 + 眼球转动（含视差） ----
  //
  // 这里区分两类图层，因为它们的「闭眼」几何完全不同：
  //
  //  ① 眼球类（eyewhite / irides）—— 闭眼时应当**消失**。
  //     做法：以闭合线为锚点纵向压缩到 0（配合 renderer 的 alpha 淡出）。
  //
  //  ② 睫毛类（eyelash）—— 闭眼时**必须保留**，而且不能压缩！
  //     eyelash.png 是「上睫毛 + 下眼睑 + 眼周阴影」的完整描边（49px 高）。
  //     如果把它和眼球一样压到 0，上睫毛与下眼睑会重叠抵消，
  //     结果只剩一条细线 —— 就是之前截图里「没有睫毛」的原因。
  //     正确做法：让**上睫毛向下移动**去贴合下眼睑，保留下弯的睫毛弧线。
  D.EyeWarp = new Deformer('EyeWarp', (x, y, c) => {
    // 该顶点属于左眼还是右眼（按贴图内横向位置）
    const split = c.def.splitAt;
    const isLeftHalf = (x - c.meta.x) < split;
    // 贴图左半 = 观者左 = 角色右眼
    const open = isLeftHalf ? P.eyeROpen : P.eyeLOpen;
    const openness = clamp(open, 0, 1);

    const lx = x - c.meta.x, ly = y - c.meta.y;
    const H = c.meta.h;

    // 闭合线 = 上/下睫毛的分界处（实测 0.67H，y≈33/49）。
    // 眼球图层闭合时压缩到此线，睫毛图层则以此为分界决定各自位移。
    const lidLine = H * 0.67;

    // ---- 眼球转动，并**限制在眼眶之内** ----
    //
    // 只有虹膜层（带 parallax）才做视线位移：
    //   eyewhite 是"眼眶"本身，它跟着视线滑动会让整个眼形跑掉；
    //   正确做法是眼眶不动、虹膜在里面滑。
    //
    // 位移上限由实测几何决定：
    //   眼白每只眼 ≈57~60 × 24~28，虹膜 32 × 24~25
    //   → 横向可用余量 (58-32)/2 ≈ 13px，纵向 (26-24.5)/2 ≈ 0.8px
    //   纵向几乎没有余量（这个画法里虹膜几乎填满眼睛），所以纵向只给很小的值，
    //   否则虹膜会从眼眶上下缘露出去 —— 这就是"眼珠跑到眼眶外"的原因。
    const px = c.def.parallax ?? 0.0;
    const isIris = px > 0;
    const hMax = c.def.eyeClampX ?? 12;   // 横向最大位移（px）
    const vMax = c.def.eyeClampY ?? 2.5;  // 纵向最大位移（px）
    let gx = 0, gy = 0;
    if (isIris) {
      const vis = 0.35 + 0.65 * openness;         // 眯眼时转动幅度随之减小
      gx = clamp(P.eyeBallX * 9.0 * vis, -hMax, hMax);
      gy = clamp(P.eyeBallY * 3.0 * vis, -vMax, vMax);
    }

    let nx = lx + gx;

    // 眯眼（大笑/微笑时下眼睑上提）
    const squint = P.exprLaugh * 0.45 + P.exprSmile * 0.18;

    let ny;
    if (c.def.eyeRole === 'lash') {
      // ② 睫毛 —— 贴图是「上睫毛弧 + 下睫毛弧」围成的完整眼形描边。
      //
      //    实测（eyelash.png 深色像素按行分布，H=49）：
      //      上弧  y = 6..32   质心 18.4 (0.38H)  ← 闭眼后它就是那条闭合线
      //      下弧  y = 34..47  质心 38.9 (0.79H)
      //      分界  y = 33      (0.67H)
      //
      //    闭眼 = 只剩**一条**向下的弧线。因为两条弧在同一张 PNG 里，
      //    任何整体位移都无法让它们"合并"——只会看起来上下睫毛同时存在。
      //    所以正确做法是两件事配合：
      //      · 上弧：**下移**到闭合线位置（承担那条线）
      //      · 下弧：由 renderer 按三角形**淡出**（见 computeAlpha）
      //    这里只负责几何位移；淡化不在这里做（变形器不掌握 alpha）。
      //
      //    位移按顶点所在分片决定：上片整片等量下移（不压缩→保形），
      //    下片不动（它马上会被淡出，动了也没意义，留着可避免撕裂）。
      const SPLIT = H * (c.def.lashSplit ?? 0.67);
      const DROP = H * (c.def.lashDrop ?? 0.30);   // 上弧下移量

      const band = H * 0.10;              // 过渡带（防撕裂）
      const up = clamp((SPLIT - ly) / band, 0, 1);
      const w = up * up * (3 - 2 * up);   // smoothstep：1 = 上弧

      const closed = 1 - openness;
      ny = ly + closed * DROP * w;
      ny += gy * 0.35;
      // 眯眼时上弧略下压（幅度小，确保不消失）
      ny += squint * H * 0.06 * w;
    } else {
      // ① 眼球：以闭合线为锚点纵向压缩
      const k = clamp(openness, 0, 1);
      ny = lidLine + (ly - lidLine) * k;
      ny += gy;
      // 眯眼：向闭合线收拢
      ny = lidLine + (ny - lidLine) * clamp(1 - squint * 0.55, 0.35, 1);
    }

    // 非对称：因为左右眼到枢轴距离不同，转头时位移不同
    nx += P.angleX * 5 * (isLeftHalf ? -1 : 1) * c.pivotDist * 0.5;
    // 转头时远侧眼睛略微纵向压缩（透视）
    ny = lidLine + (ny - lidLine) * (1 - Math.abs(P.angleX) * 0.12 * c.pivotDist);

    return [c.meta.x + nx, c.meta.y + ny];
  });

  // ---- 眉毛 ----
  D.BrowWarp = new Deformer('BrowWarp', (x, y, c) => {
    const split = c.def.splitAt;
    const isLeftHalf = (x - c.meta.x) < split;
    const by = isLeftHalf ? P.browRY : P.browLY;
    // 非对称：两侧独立取值，故不致对称
    const t = clamp(0.5 + (x - 512) / 380, 0, 1);
    const inner = 1 - t;    // 靠内侧权重
    let ny = y - by * 9;
    // 眉毛角度（挑眉/皱眉）：内侧抬起量不同
    ny -= P.browAngle * 4 * inner;
    // 抬头/低头时眉毛跟随
    ny += P.angleY * 2.5 * c.pivotDist;
    // 表情带动
    ny -= P.exprLaugh * 5 * (0.5 + 0.5 * t);
    ny -= P.exprSmile * 2.0;
    return [x, ny];
  });

  // ---- 嘴 ----
  D.MouthWarp = new Deformer('MouthWarp', (x, y, c) => {
    const lx = x - c.meta.x, ly = y - c.meta.y;
    const cx = c.meta.w / 2, cy = c.meta.h / 2;
    let ox = lx - cx, oy = ly - cy;

    // 张嘴：纵向拉伸
    const o = clamp(P.mouthOpen, 0, 1);
    let sy = 0.22 + 1.35 * o;
    let sx = 1 - 0.10 * o;

    // 嘴角上扬/下撇
    const form = P.mouthForm;
    sx *= 1 + 0.10 * Math.abs(form);
    // 嘴角（远离中轴）上下位移 -> 微笑/撇嘴，左右对称但带轻微不对称
    const edge = clamp(Math.abs(ox) / (cx + 1e-6), 0, 1);
    let dy = -form * 5.5 * edge;
    // 大笑时嘴角更上扬、嘴变宽
    dy -= P.exprLaugh * 4 * edge;
    sx *= 1 + P.exprLaugh * 0.18;
    sy *= 1 + P.exprLaugh * 0.25;

    // 左右位移（嘴部随头部转向滑动）
    let dx = P.mouthX * 4;

    // 非对称：转头时远侧嘴角位移更大
    const isLeftHalf = lx < cx;
    dx += P.angleX * 3.2 * (isLeftHalf ? -1 : 1) * (0.4 + 0.6 * edge);

    // ---- 拉伸轴跟随头部 roll（歪头时张嘴不歪嘴）----
    //
    // 用户实测：歪头(roll −0.77)时张嘴，两嘴角 y 差从 3.3 涨到 24.5px——
    // 表观倾斜被放大 ~16°。机制：局部拉伸发生在**静止竖直方向**，
    // 而曲面（HeadWarp 的 roll）已把嘴滚转 roll 角，拉伸轴与嘴轴错开，
    // 纵向拉伸变成了带剪切的斜拉。
    //
    // 对策：把局部坐标先反转 roll、缩放、再转回来——
    // 拉伸沿嘴自己的轴进行，滚转多少都不产生额外倾斜。
    const roll = P.angleZ * ANGLE_SCALE.roll;
    let nx = ox * sx + dx;
    let ny = oy * sy;
    if (roll !== 0) {
      const cr = Math.cos(-roll), sr = Math.sin(-roll);
      const oxr = ox * cr - oy * sr;
      const oyr = ox * sr + oy * cr;
      const sxr = oxr * sx + dx;
      const syr = oyr * sy;
      const cr2 = Math.cos(roll), sr2 = Math.sin(roll);
      nx = sxr * cr2 - syr * sr2;
      ny = sxr * sr2 + syr * cr2;
    }
    return [c.meta.x + cx + nx, c.meta.y + cy + ny];
  });

  // ---- 耳坠摆动（单摆） ----
  D.EarRingSway = new Deformer('EarRingSway', (x, y, c) => {
    // 枢轴在贴图顶端（挂在耳朵上）
    const px = c.meta.x + c.meta.w / 2;
    const py = c.meta.y;
    // 摆角由摆动量 + 转头方向决定。
    // ⚠ 摆幅要收敛：之前合起来最大 ~0.4rad(23°)，配合 4×8 的粗网格，
    //   个别三角形会被压到接近零面积（mesh_health 实测 6 个拉伸三角形，
    //   面积比低到 0.01）。这里把系数减半，并把网格加密到 6×12。
    const swing = P.hairSway * 0.28 + P.angleX * 0.13;
    const len = Math.max(0, y - py);
    const r = swing * 0.5;      // 弧度
    // 单摆：绕顶端旋转，长度不变 → 不会把网格压扁
    const nx = px + Math.sin(r) * len + (x - px) * Math.cos(r);
    const ny = py + len * Math.cos(r);
    return [nx, ny];
  });

  return D;
}

/**
 * 「局部动作」变形器集合 —— 这些是**该部件自己的动作**（眨眼、口型、眉毛、摆动）。
 *
 * rigid 混合绝不能作用在它们上面：
 *   · 眨眼是形变，混合 0.5 会让眼睛只闭一半 → 闭不上眼
 *   · 耳坠摆动会被减半 → 摆动不到位
 *   （眼球注视是纯平移，本来就不受混合影响。）
 */
export const LOCAL_DEFORMERS = new Set([
  'EyeWarp', 'MouthWarp', 'BrowWarp',
  'HairSwayFront', 'HairSwayBack', 'EarRingSway',
]);

/**
 * 把一个网格的全部顶点走一遍变形器链，结果写入 mesh.pos（就地修改）。
 *
 * 这是**渲染与测试共用**的唯一实现 —— 之前 renderer 与各个测试脚本各写了一份，
 * 导致改了渲染逻辑（比如加 rigid）而测试还在跑旧逻辑，测出来的东西
 * 和线上实际行为不一致。抽成一个纯函数就没有这个问题了。
 *
 * 层级：链上先「曲面段」（BodyWarp/HeadWarp/FaceWarp，整颗头共用），
 * 后「局部动作段」（见 LOCAL_DEFORMERS）。
 *
 * rigid（可选，取 0..1，写在图层定义上）：
 *   Live2D 的 rigid 语义 —— 位置仍然**精确跟随曲面**，但自身形变按比例减弱。
 *     v' = rigid · W(v) + (1 − rigid) · ( v + W(center) − center )
 *   在中心点两项相等，所以位置不会偏移；rigid=0 时整块刚性平移。
 */
export function deformMesh(mesh, P, D) {
  const chain = mesh.def.warpChain;
  const n = mesh.rest.length;
  if (!mesh.ctx) {
    mesh.ctx = { def: mesh.def, meta: mesh.meta, sideL: 0, sideR: 0, pivotDist: 0 };
  }
  const c = mesh.ctx;

  const runChain = (x, y, seg) => {
    for (const [dname, weightSpec] of seg) {
      const dfm = D[dname];
      if (!dfm) continue;
      // 权重可以是常数，也可以是 (x,y,c) => number 的函数（脖子/衣领用它做渐变）
      const weight = typeof weightSpec === 'function'
        ? clamp(weightSpec(x, y, c), 0, 1)
        : weightSpec;
      if (weight >= 1) {
        const p = dfm.apply(x, y, c);
        x = p[0]; y = p[1];
      } else if (weight > 0) {
        const p = dfm.apply(x, y, c);
        x = x + (p[0] - x) * weight;
        y = y + (p[1] - y) * weight;
      }
    }
    return [x, y];
  };

  // 在链上找到「曲面段 / 局部动作段」的分界
  let splitIdx = chain.length;
  for (let k = 0; k < chain.length; k++) {
    if (LOCAL_DEFORMERS.has(chain[k][0])) { splitIdx = k; break; }
  }
  const surfaceSeg = chain.slice(0, splitIdx);
  const localSeg = chain.slice(splitIdx);

  const rigid = (typeof mesh.def.rigid === 'number') ? clamp(mesh.def.rigid, 0, 1) : 1;

  // 该部件的中心（用它的静止顶点均值，比贴图中心更贴合实际覆盖范围）
  let ccx = 0, ccy = 0;
  for (let i = 0; i < n; i++) {
    ccx += mesh.rest[i][0] + mesh.meta.x;
    ccy += mesh.rest[i][1] + mesh.meta.y;
  }
  ccx /= n; ccy /= n;

  // ---- 「整体移动」的部件（feature）：五官 ----
  //
  // 这是 Live2D 的标准做法（rigkit 的 surface.feature）：
  //   部件**按自己中心的位移量整体移动**，再叠上"中心处的局部线性形变
  //   （雅可比）× rigid" ——
  //       v' = v + d0 + rigid · ( qₓ·Jₓ + q_y·J_y ),  q = v − centre
  //
  // 两个好处，正好对上用户的两条要求：
  //   ① **整体移动** ⇒ 部件的形状不会因为位移场的高阶项而弯曲、错位，
  //      五官之间的相对距离被"锁死"（各自的中心按同一场移动，不会各走各的）。
  //   ② 形变被限制为**线性**且被 rigid 打折 ⇒ 不会出现"被拉长/压扁"。
  //
  // 非 feature 的图层（脸、头发、衣服）仍走逐顶点路径，让曲面本身能自然弯。
  const isFeature = !!mesh.def.feature;
  let d0x = 0, d0y = 0, jxx = 1, jyx = 0, jxy = 0, jyy = 1;
  let cxShift = 0, cyShift = 0;
  if (isFeature || rigid < 1) {
    c.sideL = 0.5; c.sideR = 0.5; c.pivotDist = 0.5;
    const pH = 2;   // 有限差分步长（与 rigkit 一致）
    const pc = runChain(ccx, ccy, surfaceSeg);
    d0x = pc[0] - ccx; d0y = pc[1] - ccy;
    cxShift = d0x; cyShift = d0y;
    if (isFeature) {
      const pxp = runChain(ccx + pH, ccy, surfaceSeg);
      const pxm = runChain(ccx - pH, ccy, surfaceSeg);
      const pyp = runChain(ccx, ccy + pH, surfaceSeg);
      const pym = runChain(ccx, ccy - pH, surfaceSeg);
      // ⚠ 这里要的是**位移场 D 的雅可比**，不是「位置映射 x' = x + D」的雅可比！
      //   两者的差别就是单位矩阵：∂x'/∂x = 1 + ∂D/∂x。
      //   之前忘了减这个 1，导致 jxx≈1 而不是≈0，
      //   于是 rigid·(q·J) ≈ rigid·q —— **把整个部件缩放成 rigid 倍**
      //   （虹膜 rigid=0.4 ⇒ 面积只剩 0.4²=0.16，实测 0.135，眼睛缩成 40% 大，
      //     五官四周因此露出缝隙，画面上就是那些白色条纹）。
      //   skill 的 surface.feature 里 field() 返回的正是位移，所以它不需要减 1。
      jxx = (pxp[0] - pxm[0]) / (2 * pH) - 1;   // ∂Dx/∂x
      jyx = (pyp[0] - pym[0]) / (2 * pH);       // ∂Dx/∂y
      jxy = (pxp[1] - pxm[1]) / (2 * pH);       // ∂Dy/∂x
      jyy = (pyp[1] - pym[1]) / (2 * pH) - 1;   // ∂Dy/∂y
    }
  }

  for (let i = 0; i < n; i++) {
    c.sideL = mesh.sideL[i];
    c.sideR = mesh.sideR[i];
    c.pivotDist = mesh.pivotDist[i];
    const rx = mesh.rest[i][0] + mesh.meta.x;
    const ry = mesh.rest[i][1] + mesh.meta.y;

    let x, y;
    if (isFeature) {
      // ---- 顺序很重要：**先局部动作，再走曲面仿射映射** ----
      //
      // 反过来（先曲面、再局部）会踩到一个很隐蔽的坑：
      // 局部动作变形器（如 MouthWarp）是「以**静止**中心为基准做缩放」的，
      //   返回的是  rest_centre + (x − rest_centre)·s
      // 于是**头部传来的整体位移也会被这个 s 乘一遍**。
      // MouthWarp 的 sy = 0.22 + 1.35·mouthOpen（张嘴时约 0.56），
      // 结果嘴巴只跟上头部 56% 的位移 —— 实测鼻 +33.5px 而嘴只有 +19.2px，
      // 五官相对距离被拉大 24%，正是用户说的"没有锁死"。
      //
      // 先做局部动作、再让曲面映射**整体搬动**它，局部缩放就不再影响位移。
      // 这也正是 Live2D 的做法：surface.feature(v, centre) 里的 v
      // 应当是已经过局部变形后的点。
      // ---- 五官：先做局部动作，再叠加曲面位移场 ----
      //
      //   v_local = 局部动作后的点（眨眼/注视/口型都已足额生效）
      //   v'      = v_local + d0 + rigid·(q·J),   q = v_local − centre
      //             J = ∂D/∂x（**位移场**的雅可比，见上面的说明）
      //
      // 这个形式同时满足四条要求（前三种写法都实测踩过坑）：
      //   · 基点用 v_local 而不是 centre ⇒ 部件**尺寸不会被 rigid 缩放**
      //     （之前 jxx 忘了减 1，五官被缩到 rigid 倍，眼睛只有 40% 大）
      //   · d0 不加权 ⇒ 头部平移足额，五官紧跟脸走
      //   · J 是位移梯度、且整体乘 rigid ⇒ 只削弱"曲面带来的额外形变"，
      //     局部动作（眨眼压扁等）完整保留 ⇒ 眼睛闭得上
      //   · 注视是平移，不在 J 项里 ⇒ 幅度不被削弱（18px 保持 18px）
      const [lx2, ly2] = runChain(rx, ry, localSeg);
      const qx = lx2 - ccx;
      const qy = ly2 - ccy;
      x = lx2 + d0x + rigid * (qx * jxx + qy * jyx);
      y = ly2 + d0y + rigid * (qx * jxy + qy * jyy);
      mesh.pos[i][0] = x;
      mesh.pos[i][1] = y;
      continue;
    }

    // ---- 其余图层：同样是「先局部动作，再曲面」----
    //
    // 顺序对**所有**图层都必须是这个 —— 因为局部动作变形器都是在
    // **静止坐标系**里写的。最典型的是 EarRingSway（耳坠单摆）：
    // 它用 `len = max(0, y - meta.y)` 当摆长，默认 y 一定 ≥ meta.y；
    // 但如果先走曲面（抬头会把耳坠整体上移 34px），y 就可能小于 meta.y，
    // len 被夹成 0 ⇒ **整个耳坠塌成一个点**（实测四边形面积比 0.000）。
    const [lx2, ly2] = runChain(rx, ry, localSeg);
    const [sx2, sy2] = runChain(lx2, ly2, surfaceSeg);
    if (rigid < 1) {
      // rigid 混合：在"完全跟随曲面"与"整块按中心位移平移"之间插值
      x = rigid * sx2 + (1 - rigid) * (lx2 + cxShift);
      y = rigid * sy2 + (1 - rigid) * (ly2 + cyShift);
    } else {
      x = sx2; y = sy2;
    }

    mesh.pos[i][0] = x;
    mesh.pos[i][1] = y;
  }
}

export { clamp, lerp, smooth };
