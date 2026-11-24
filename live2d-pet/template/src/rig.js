/**
 * rig.js — 皮套骨骼/变形器定义（模板版）
 *
 * 与标准品（pet/）的唯一差别：所有**画布几何**集中在本文件顶部的 GEO，
 * 由 make_avatar.py 按 PSD 自动推导后生成。其余逻辑（变形器、渲染、追踪）
 * 与标准品逐行一致 —— 数值不变，只把字面量换成 GEO 引用。
 *
 * 设计要点（对应 Live2D 的三层结构）：
 *   1. 参数层 (Parameter)  : 由人脸追踪写入的归一化值
 *   2. 变形器层 (Deformer) : 嵌套层级，父变形器位移带动所有子节点
 *   3. 网格层 (ArtMesh)    : 每层贴图切成顶点网格，顶点受多层变形器加权影响
 *
 * ⚠ 本文件由 make_avatar.py **整体生成**（LAYERS 与 GEO 都是）。
 *   手工微调请改生成脚本里的派生规则，或生成后直接改这个文件。
 */

// ---------------------------------------------------------------------------
// 画布几何（★由 make_avatar.py 按 PSD 推导★）
//   下面的数值是标准品（1024 画布 PSD）的推导结果，作为默认与对照。
// ---------------------------------------------------------------------------
export const GEO = {
  canvas: { w: 1024, h: 1024 },
  cx: 512,                          // 画布中心 x（左右权重/渐变的基准）

  // 头部枢轴：脖子根部（脸底下方一点点）
  pivot: { x: 512, y: 470 },
  pivotNorm: 420,                   // pivotDist 的归一化距离

  // 颅顶衰减（转头挤压按高度打折：球状颅顶几乎不压）
  head: { top: 120, fadeSpan: 210 },

  // pitch 位移场的"平坦区"椭圆——必须盖住脸层**四个角**
  // （脸 240×318，角点归一化半径 hypot(120/rx,159/ry)；165/210 时角点
  //   r=1.049 在椭圆外 → 点头时脸内剪切，网格接缝显形成"三角形的线"）
  pitch: { cx: 512, cy: 305, rx: 126, ry: 167 },

  // 头发外轮廓反向移动的椭圆（脸外发梢滞后 => 有厚度）
  sil: { cx: 512, cy: 305, rx: 132, ry: 168 },

  // 躯干圆柱（腰以下不动，越往上跟得越多）
  body: { cx: 512, hemY: 900, fall: 500 },

  // FaceWarp 的脸部中心
  faceWarp: { cx: 512, cy: 330 },

  // 头发左右渐变跨度
  hairSide: { span: 500 },

  // 眉毛横向跨度
  brow: { span: 380 },

  // 脖子：可见段**近刚体**（base），在衣领以下才过渡到只跟身体。
  // y0 必须在**脖子下缘以下**（脸底+0.24 脸高）——若从脸底就开始降，
  // 脖底权重掉到 0.5，可见段点头仍被拉伸 ~6%（实测教训）。
  neck: { y0: 540, span: 160, drop: 0.68, base: 0.9 },
  // 衣领：领口跟头多一些，向下过渡到几乎不动
  collar: { y0: 500, span: 420, base: 0.42, drop: 0.36 },

  // 取景框：画布元素显示画布坐标的这一区域（裁掉下摆以下）
  src: { x: 140, y: 0, w: 760, h: 900 },
};

// ---------------------------------------------------------------------------
// 画布与坐标
// ---------------------------------------------------------------------------
export const CANVAS = GEO.canvas;

// 头部枢轴：脖子根部，转头时绕此点旋转
export const HEAD_PIVOT = GEO.pivot;

/** 取 0..1（rig.js 内自用，避免依赖 deformer.js） */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// 图层栈（自下而上绘制）
//   warpChain: 该网格受哪些变形器影响，以及权重（按顺序施加）
//   mesh:      网格细分密度
//   side:      'L' | 'R' | 'C' —— 用于非对称参数
// ---------------------------------------------------------------------------
export const LAYERS = [
  {
    id: 'topwear', file: 'topwear.png', z: 0,
    // 上衣在脖子**下面**（see-through 的高领在 topwear 里画得很高，
    // 若上衣压脖子会整段盖住脖子——用户实测"脖子被压在衣服后面"）。
    // 衣领沿高度 smoothstep 渐变：领口跟头多一些，下摆几乎不动。
    // pitchGain：点头位移几乎不传给躯干（0.42×34 曾让肩部动 14px="耸肩"）。
    pitchGain: 0.08,
    yawGain: 0.1,
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {
        const t = clamp01((y - GEO.collar.y0) / GEO.collar.span);
        return GEO.collar.base - (t * t * (3 - 2 * t)) * GEO.collar.drop;
      }],
    ],
    mesh: { cols: 16, rows: 16 }, side: 'C',
    vyFalloff: { from: 1.0, to: 0.15 },
  },
  {
    id: 'neck', file: 'neck.png', z: 1,
    // 脖子：可见段近刚体（base≈0.9，点头纹理零拉伸），下端塞进前衣领下面。
    // ⚠ 不要用 bottomFade 渐隐——半透明三角形叠在深色高领上会显出
    //   逐三角形接缝（"网格带"，用户实测）。用下面的前衣领复制层盖住。
    // pitchGain 0.45：点头时脖子跟 ~45%，下颌相对滑动藏在脸层下面，
    //   脖底边缘始终在 topwear_collar 的裁剪带内。
    pitchGain: 0.45,
    // yawGain（函数）：顶部跟头 60%、根部锚 10% —— 脖子是弯的，不是滑的。
    // （全跟=脖子位移；全 0=头脖脱节。均来自用户实测。）
    yawGain: (x, y) => 0.55 - 0.45 * clamp01((y - GEO.neck.y0) / 85),
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {
        const t = clamp01((y - GEO.neck.y0) / GEO.neck.span);
        return GEO.neck.base - (t * t * (3 - 2 * t)) * GEO.neck.drop;
      }],
      ['FaceWarp', 0.12],
    ],
    mesh: { cols: 10, rows: 16 }, side: 'C',
  },
  {
    id: 'topwear_collar', file: 'topwear.png', z: 1.5,
    // 前衣领复制层：同贴图同变形画第二遍，clipRect 只露领口带——
    // 用户指定层序「前衣领压脖子、脖子压后衣领」的等效实现
    //（see-through 把前后领合在一份 topwear 里，无法直接拆层）。
    // 两份变形完全一致 ⇒ 重叠区像素相同 ⇒ 裁剪边缘无缝。
    clipRect: { x: 415, y: 530, w: 200, h: 140 },
    pitchGain: 0.08,
    yawGain: 0.1,
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {
        const t = clamp01((y - GEO.collar.y0) / GEO.collar.span);
        return GEO.collar.base - (t * t * (3 - 2 * t)) * GEO.collar.drop;
      }],
    ],
    mesh: { cols: 16, rows: 16 }, side: 'C',
  },

  // ---- 头部图层都挂在 HeadWarp 下 ----
  {
    id: 'back_hair', file: 'back_hair.png', z: 2,
    // 后发 HeadWarp 权重 0.93（略小于前层）——**图层视差**：
    // 后发在头后方，位移略小，与脸/前发错开一点 => 有"厚度"不纸片。
    // 幅度刻意小（7%），避免前后发错开过多出现"两道轮廓"。
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 0.93], ['HairSwayBack', 1.0]],
    mesh: { cols: 14, rows: 14 }, side: 'C',
    swayDelay: 0.85,
  },
  {
    id: 'earwear', file: 'earwear.png', z: 3,
    // 耳坠是刚体吊坠：不吃 FaceWarp（带 clamp 的梯度有折点，网格会被压扁）。
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['EarRingSway', 1.0]],
    mesh: { cols: 6, rows: 14 }, side: 'R',
    pendulum: { pivotY: 0.0, gain: 1.0 },
    rigid: 0.35,
    yawDepth: -0.6,
  },
  {
    id: 'ears', file: 'ears.png', z: 4,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: { cols: 10, rows: 6 }, side: 'C',
    rigid: 0.7,
    yawDepth: -0.5,
  },
  {
    id: 'face', file: 'face.png', z: 5,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: { cols: 16, rows: 18 }, side: 'C',
  },

  // ---- 五官：feature=true（整体移动，锁死相对距离）+ rigid（自身形变打折）----
  {
    id: 'nose', file: 'nose.png', z: 6,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: { cols: 4, rows: 5 }, side: 'C',
    feature: true,
    rigid: 0.45,
    yawDepth: 1.0,     // 脸上最凸
  },
  {
    id: 'mouth', file: 'mouth.png', z: 7,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['MouthWarp', 1.0]],
    mesh: { cols: 10, rows: 8 }, side: 'C', soft: true,
    feature: true,
    rigid: 0.5,
    yawDepth: -0.25,
  },
  {
    id: 'eyewhite', file: 'eyewhite.png', z: 8,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    mesh: { cols: 12, rows: 6 }, side: 'LR', soft: true,
    splitAt: 89,           // 贴图内左右眼分界（由 PSD 的透明列间隙自动推导）
    eyeRole: 'ball',
    feature: true,
    rigid: 0.5,
    yawDepth: -0.45,
  },
  {
    id: 'irides', file: 'irides.png', z: 9,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    mesh: { cols: 8, rows: 6 }, side: 'LR', soft: true,
    splitAt: 75,
    eyeRole: 'ball',
    feature: true,
    rigid: 0.4,            // 虹膜是圆盘，最"硬"
    yawDepth: -0.55,
    parallax: 0.9,         // 只有虹膜做视线位移（眼眶不动、虹膜在里面滑）
    eyeClampX: 12,         // 位移上限按眼白/虹膜实测几何推导
    eyeClampY: 2.5,
  },
  {
    id: 'eyelash', file: 'eyelash.png', z: 10,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    // 网格要密：细长描边行数太少会被拉断；淡出边界按行判定，行数不足呈阶梯。
    mesh: { cols: 20, rows: 16 }, side: 'LR', soft: true,
    splitAt: 107,
    eyeRole: 'lash',
    lashSplit: 0.62,       // 淡出分界（上下弧间隙行 − 0.05，防跨界块残留）
    lashDrop: 0.30,        // 闭眼时上弧下移量 =（间隙行 − 上弧质心）/H
    feature: true,
    rigid: 0.5,
    yawDepth: -0.3,
  },
  {
    id: 'eyebrow', file: 'eyebrow.png', z: 11,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['BrowWarp', 1.0]],
    mesh: { cols: 12, rows: 4 }, side: 'LR', soft: true,
    splitAt: 105,
    feature: true,
    rigid: 0.5,
    yawDepth: 0.25,
  },

  {
    id: 'front_hair', file: 'front_hair.png', z: 12,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['HairSwayFront', 1.0]],
    mesh: { cols: 16, rows: 16 }, side: 'C',
    swayDelay: 1.0,
    // 刘海非对称摆动（左右碎发量不同时的观感校正；无依据时保持 1:1 也行）
    asymmetric: { L: 0.75, R: 1.35 },
  },
];

// ---------------------------------------------------------------------------
// 参数定义（范围与默认值）
// ---------------------------------------------------------------------------
export const PARAMS = {
  angleX:      { min: -1, max: 1, def: 0 },   // 左右转头 yaw
  angleY:      { min: -1, max: 1, def: 0 },   // 上下点头 pitch
  angleZ:      { min: -1, max: 1, def: 0 },   // 左右歪头 roll

  bodyAngleX:  { min: -1, max: 1, def: 0 },
  breath:      { min: -1, max: 1, def: 0 },

  eyeLOpen:    { min: 0, max: 1, def: 1 },
  eyeROpen:    { min: 0, max: 1, def: 1 },
  eyeBallX:    { min: -1, max: 1, def: 0 },
  eyeBallY:    { min: -1, max: 1, def: 0 },
  browLY:      { min: -1, max: 1, def: 0 },
  browRY:      { min: -1, max: 1, def: 0 },
  browAngle:   { min: -1, max: 1, def: 0 },

  mouthOpen:   { min: 0, max: 1, def: 0.25 },
  mouthForm:   { min: -1, max: 1, def: 0 },
  mouthX:      { min: -1, max: 1, def: 0 },

  exprSmile:   { min: 0, max: 1, def: 1 },
  exprLaugh:   { min: 0, max: 1, def: 0 },
  exprBlink:   { min: 0, max: 1, def: 0 },
  exprCalm:    { min: 0, max: 1, def: 0 },

  hairSway:    { min: -1, max: 1, def: 0 },
  hairSwayY:   { min: -1, max: 1, def: 0 },
};

/** 角度映射：归一化参数 -> 弧度 */
export const ANGLE_SCALE = {
  yaw:   26 * Math.PI / 180,
  pitch: 18 * Math.PI / 180,
  roll:  16 * Math.PI / 180,
};
