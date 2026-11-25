"""make_avatar.py — 从 See-through 分层 PSD 生成可直接使用的网页版 Live2D 皮套。

用法：
    python make_avatar.py <输入.psd> <输出目录> [--name 角色名] [--check]

流程：
  1. 读取 PSD 图层（自下而上），按图层名映射到角色部件
  2. 每层导出 PNG（裁到不透明 bbox），并从 alpha 几何推导绑定参数：
       · splitAt        —— 左右眼分界 = 最长透明列间隙的中点
       · eyeClampX/Y    —— 眼白与虹膜实测尺寸的余量
       · lashSplit/Drop —— 睫毛上下弧的间隙行与上弧质心
       · GEO            —— 脸椭圆/躯干圆柱/颅顶衰减/取景框等（按标准品校准的比例式）
  3. 生成 <输出>/src/rig.js（图层栈 + GEO），其余文件从 template 原样拷贝
  4. --check 时调用 check_avatar.mjs 做行为自检（须全部 PASS）

所有比例系数都以标准品（pet/，1024 画布 PSD）标定：
  换任何分辨率的 PSD，先换算 S = 画布宽/1024，再套同一组比例。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import warnings

import numpy as np
from PIL import Image

# GBK 控制台打不出部分符号时也不至于崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(SKILL, "template")
CHECKER = os.path.join(SKILL, "scripts", "check_avatar.mjs")

# 标准品（1024 画布）的对照值——仅用于 --check 校准报告，不参与推导
REFERENCE = {
    "splitAt": {"eyewhite": 89, "irides": 75, "eyelash": 107, "eyebrow": 105},
    "lashSplit": 0.62, "lashDrop": 0.30,
    "eyeClampX": 12, "eyeClampY": 2.5,
    "pivot": [512, 470], "src": [140, 0, 760, 900],
}

# --------------------------------------------------------------- 角色名映射
ROLE_MAP = [
    (r"^(neck|脖子)$", "neck"),
    (r"^(topwear|body|clothes|cloth|wear|衣服|上衣|身体)$", "topwear"),
    (r"^(earring|earwear|ear_ring|dangle|ear_ring|耳坠|耳饰)$", "earwear"),
    (r"^(ears?|耳朵)$", "ears"),
    (r"^(face|skin|脸|脸部|皮肤)$", "face"),
    (r"^(mouth|嘴|嘴巴)$", "mouth"),
    (r"^(nose|鼻|鼻子)$", "nose"),
    (r"^(eyewhite|eye_white|sclera|white|眼白)$", "eyewhite"),
    (r"^(eyelash|eye_lash|lash|eyelashes|睫毛)$", "eyelash"),
    (r"^(irides|iris|eyeball|pupil|eye|虹膜|眼球|瞳孔)$", "irides"),
    (r"^(eyebrow|eye_brow|brow|brows|眉毛)$", "eyebrow"),
    (r"^(front[_ ]?hair|hair[_ ]?front|bangs|前发|刘海|头发前)$", "front_hair"),
    (r"^(back[_ ]?hair|hair[_ ]?back|后发|头发后)$", "back_hair"),
]


def norm_name(s):
    return re.sub(r"[\s_\-]+", "", s.strip().lower())


def guess_role(name, idx, total, bbox, canvas_h):
    n = norm_name(name)
    for pat, role in ROLE_MAP:
        if re.match(pat, n):
            return role
    # 兜底：含 hair 的按上下位置分前后；其余按"是否在脸部高度带"
    if "hair" in n or "发" in n:
        return "front_hair" if bbox[1] < canvas_h * 0.35 else "back_hair"
    cy = (bbox[1] + bbox[3]) / 2
    print(f"  [!] 未识别图层 '{name}'，按位置归为 {'front_hair' if cy < canvas_h*0.5 else 'topwear'}")
    return "front_hair" if cy < canvas_h * 0.5 else "topwear"


# --------------------------------------------------------------- alpha 几何
def alpha_of(img):
    return np.array(img.getchannel("A"))


def col_segments(a, thr=8, min_gap=4):
    """按列不透明性分段：返回 [(x0,x1), ...]（含端点）。"""
    cols = (a > thr).any(axis=0)
    xs = np.nonzero(cols)[0]
    if len(xs) == 0:
        return []
    segs, st, prev = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - prev > min_gap:
            segs.append((st, prev))
            st = x
        prev = x
    segs.append((st, prev))
    return segs


def split_from_alpha(a):
    """左右分界 = 最靠近图层中线的透明列间隙中点（并列取最长）。

    标准品四个 LR 层全部命中 ±0px。不用"最长间隙"——眉毛层最长的
    间隙可能出现在眉尾内侧，而左右分界应当是靠近中线的那个。
    """
    segs = col_segments(a)
    if len(segs) < 2:
        return None
    mid = a.shape[1] / 2
    best = None
    for i in range(len(segs) - 1):
        length = segs[i + 1][0] - segs[i][1]
        center = (segs[i][1] + segs[i + 1][0]) / 2
        key = (abs(center - mid), -length)
        if best is None or key < best[0]:
            best = (key, round(center))
    return best[1]


def eye_clamps(a_sclera, a_iris):
    """横向/纵向注视上限：由眼白与虹膜的实测尺寸推余量（标准品 12 / 2.5）。"""
    ss = col_segments(a_sclera)
    iseg = col_segments(a_iris)
    if not ss or not iseg:
        return 12, 2.5
    sw = max(e - s + 1 for s, e in ss)          # 单只眼白宽
    iw = max(e - s + 1 for s, e in iseg)        # 单只虹膜宽
    rows = lambda a: (np.nonzero((a > 8).any(axis=1))[0])
    rs, ri = rows(a_sclera), rows(a_iris)
    sh = (rs.max() - rs.min() + 1) if len(rs) else 28
    ih = (ri.max() - ri.min() + 1) if len(ri) else 24
    hx = max(6.0, (sw - iw) / 2 * 0.96)
    vy = float(np.clip((sh - ih) / 2 * 1.2, 2.0, 3.0))
    return round(hx, 1), round(vy, 1)


def lash_profile(a):
    """睫毛闭合线标定。

    ⚠ 行剖面法不可行：睫毛的弧线在两端下垂，**任何一行**都有像素
      （标准品 49 行全部非零），找不到全宽零行带。
    可行的是**列内游程**：每列从上到下是「上弧 → 空隙 → 下弧」，
    第二段游程的起点 = 下弧顶边 = 闭合线位置的实测值。

    与 EyeWarp 的锚点一致：deformer.js 里眼球闭合计锚在 H*0.67，
    所以这里：
        lashSplit = 0.67 - 0.05        （淡出分界，防跨界块残留）
        lashDrop  = 0.67 - 上弧质心比   （上弧平移后质心正好落在闭合线上）
    标准品实测：0.62 / 0.295（手工值 0.62 / 0.30）。
    若新 PSD 的下弧顶边明显偏离 0.67H，应同步调 deformer.js 的 lidLine。
    """
    h = a.shape[0]
    act = a > 8
    xs = np.nonzero(act.any(axis=0))[0]
    if len(xs) < 2:
        return 0.62, 0.30
    segs = []
    st = prev = int(xs[0])
    for x in xs[1:]:
        if x - prev > 4:
            segs.append((st, prev))
            st = int(x)
        prev = int(x)
    segs.append((st, prev))

    ANCHOR = 0.67                       # 与 deformer.js 的 EyeWarp lidLine 一致
    starts2 = []
    for s0, s1 in segs:
        c0, c1 = int(s0 + (s1 - s0) * 0.2), int(s0 + (s1 - s0) * 0.8)
        for x in range(c0, c1 + 1):
            ys = np.nonzero(act[:, x])[0]
            if len(ys) < 2:
                continue
            runs = []
            r0 = rp = int(ys[0])
            for y in ys[1:]:
                if y - rp > 2:
                    runs.append((r0, rp))
                    r0 = int(y)
                rp = int(y)
            runs.append((r0, rp))
            if len(runs) >= 2:
                starts2.append(runs[1][0])
    if len(starts2) < 5:               # 找不到可靠的下弧：退回标准品默认
        return 0.62, 0.30

    lat = float(np.median(starts2)) / h
    ys_idx = np.arange(h)
    rows = act.sum(axis=1).astype(float)
    up = rows.copy()
    up[int(ANCHOR * h) + 1:] = 0
    uc = float((ys_idx * up).sum() / max(up.sum(), 1)) / h
    return round(ANCHOR - 0.05, 3), round(ANCHOR - uc, 3)


# ----------------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("psd")
    ap.add_argument("out")
    ap.add_argument("--name", default="角色")
    ap.add_argument("--check", action="store_true", help="生成后跑行为自检")
    args = ap.parse_args()

    try:
        from psd_tools import PSDImage
    except ImportError:
        print("缺少 psd-tools。本机无 pip 时可先跑 tools/fetch_deps.py 的办法："
              "从 PyPI 下载 wheel 解包到 PYTHONPATH 目录。")
        sys.exit(1)

    print(f"读取 {args.psd}")
    psd = PSDImage.open(args.psd)
    W, H = psd.width, psd.height
    S = W / 1024.0     # 标准品校准比例尺
    layers = [l for l in psd if l.is_visible()]
    print(f"画布 {W}x{H}，可见图层 {len(layers)} 个，比例尺 S={S:.3f}")

    out = os.path.abspath(args.out)
    if os.path.isdir(out):
        print(f"[!] 输出目录已存在，将覆盖：{out}")
    os.makedirs(os.path.join(out, "layers"), exist_ok=True)
    os.makedirs(os.path.join(out, "src"), exist_ok=True)

    # ---- 1. 提取图层 ----
    entries = []          # (role, name, file, x, y, w, h, img, z)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for z, l in enumerate(layers):
            bbox = l.bbox
            if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                print(f"  [!] 空图层跳过：{l.name}")
                continue
            # ⚠ 必须用 topil()（原始图层像素）。composite() 会做层合成，
            #   把相邻层透进来的像素烘进本层（对照标准品实测：eyelash 差 253、
            #   face 差 192，6905 个像素被污染，绑定推导全部失真）。
            img = l.topil()
            if img is None:
                print(f"  [!] 空图层跳过：{l.name}")
                continue
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            role = guess_role(l.name, z, len(layers), bbox, H)
            fname = role + ".png"
            img.save(os.path.join(out, "layers", fname))
            entries.append(dict(role=role, name=l.name, file=fname, z=z,
                                x=bbox[0], y=bbox[1],
                                w=bbox[2] - bbox[0], h=bbox[3] - bbox[1],
                                img=img))
            print(f"  [{z:2d}] {l.name:<12} -> {role:<10} ({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]})")

    roles = {e["role"]: e for e in entries}
    for need in ["face", "neck", "eyewhite", "irides", "eyelash", "mouth", "nose", "eyebrow"]:
        if need not in roles:
            print(f"[FAIL] PSD 缺少必需图层 '{need}'（see-through 输出应包含）")
            sys.exit(1)

    # ---- 2. 推导绑定参数 ----
    f_ = roles["face"]
    fx0, fy0 = f_["x"], f_["y"]
    fw, fh = f_["w"], f_["h"]
    fcx, fcy = fx0 + fw / 2, fy0 + fh / 2
    fb = fy0 + fh                        # 脸底（下巴线）

    A = {r: alpha_of(e["img"]) for r, e in roles.items()}

    split = {}
    for r in ("eyewhite", "irides", "eyelash", "eyebrow"):
        v = split_from_alpha(A[r])
        split[r] = v if v is not None else REFERENCE["splitAt"][r]
        ref = REFERENCE["splitAt"][r]
        flag = "OK" if abs(v - ref) <= 2 else ("与标准品差 %dpx" % abs(v - ref))
        print(f"  splitAt[{r}] = {split[r]}   (标准品 {ref} {flag})")

    ecx, ecy = eye_clamps(A["eyewhite"], A["irides"])
    print(f"  eyeClamp = {ecx} / {ecy}   (标准品 12 / 2.5)")
    ls, ld = lash_profile(A["eyelash"])
    print(f"  lashSplit={ls} lashDrop={ld}   (标准品 0.62 / 0.30)")

    meta = {"canvas": {"w": W, "h": H},
            "layers": [{k: e[k] for k in ("file", "x", "y", "w", "h")} for e in entries]}
    with open(os.path.join(out, "layers", "layers_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    # ---- 3. GEO（比例式全部按标准品标定，见 references/tuning.md）----
    hem_y = min(H, round((fb - 0.2 * fh) + 1.57 * fh))       # 躯干圆柱的下摆固定线
    geo = {
        "canvas": {"w": W, "h": H},
        "cx": W // 2,
        "pivot": {"x": W // 2, "y": round(fb + 0.022 * fh)},
        "pivotNorm": round(1.32 * fh),
        "head": {"top": round(fcy - 1.164 * fh / 2),
                 "fadeSpan": round(0.16 * fh / 2 + 1.164 * fh / 2)},
        # pitch 平坦区椭圆必须盖住脸层**四角**：
        # 角点归一化半径 hypot(0.5/0.75, 0.5/0.739)≈0.90 <1 → 点头时脸内零剪切。
        # （165/210 那版角点 r=1.049 在椭圆外，点头脸上会出现三角形接缝。）
        # 穹顶场椭圆必须**贴合脸部**（半轴≈脸半轴×1.05）：
        # 中心 Q≈1.0、轮廓 0.45~0.60 —— 五官领先轮廓，点头才有透视形变；
        # 放大到盖住四角（旧平移方案）会让整脸都在平台区，头又不动了。
        "pitch": {"cx": W // 2, "cy": round(fcy),
                  "rx": round(fw * 0.525), "ry": round(fh * 0.525)},
        "sil": {"cx": W // 2, "cy": round(fcy),
                "rx": round(fw * 0.55), "ry": round(fh * 0.528)},
        "body": {"cx": W // 2, "hemY": hem_y,
                 "fall": round(hem_y - (fb - 0.2 * fh))},
        "faceWarp": {"cx": W // 2, "cy": round(fcy + 0.079 * fh)},
        "hairSide": {"span": round(2.08 * fw)},
        "brow": {"span": round(1.583 * fw)},
        # 脖子：可见段近刚体（base 0.9，点头不伸缩），衣领以下才过渡到身体。
        # ⚠ 过渡带起点必须在**脖子下缘以下**（脸底+0.24 脸高 ≈ 脖子下缘+一点）：
        #   若从脸底就开始降，脖底权重掉到 ~0.5，可见段点头仍被拉伸 ~6%（实测）。
        #   终点（y0+0.5 脸高）藏在衣领下面，由上衣（PSD 原序压在脖子上）盖住。
        "neck": {"y0": round(fb + 0.24 * fh), "span": round(0.5 * fh),
                 "drop": 0.68, "base": 0.9},
        "collar": {"y0": round(fb + 0.116 * fh), "span": round(1.32 * fh),
                   "base": 0.42, "drop": 0.36},
        "src": None,   # 下面算
    }
    ux0 = min(e["x"] for e in entries); ux1 = max(e["x"] + e["w"] for e in entries)
    uy0 = min(e["y"] for e in entries); uy1 = max(e["y"] + e["h"] for e in entries)
    pad = round(0.0244 * W)
    geo["src"] = {"x": max(0, ux0 - pad), "y": max(0, uy0 - pad),
                  "w": min(W, ux1 + pad) - max(0, ux0 - pad),
                  "h": hem_y - max(0, uy0 - pad)}
    print(f"  GEO.pivot = {geo['pivot']}   (标准品 {REFERENCE['pivot']})")
    print(f"  GEO.src   = ({geo['src']['x']},{geo['src']['y']},{geo['src']['w']},{geo['src']['h']})"
          f"   (标准品 {tuple(REFERENCE['src'])})")

    # ---- 4. 生成 rig.js ----
    clip = {
        "clip_x": roles["neck"]["x"] - 15,
        "clip_y": round(fb + 0.20 * fh),
        "clip_w": roles["neck"]["w"] + 30,
        "clip_h": round(0.45 * fh),
    }
    rig = render_rig(geo, split, ecx, ecy, ls, ld, clip)
    with open(os.path.join(out, "src", "rig.js"), "w", encoding="utf-8") as f:
        f.write(rig)

    # ---- 5. 拷贝模板其余文件（deformer/renderer/tracking/main/style/index/serve/vendor）----
    for rel in ["src/deformer.js", "src/renderer.js", "src/tracking.js", "src/main.js",
                "src/style.css", "index.html", "serve.py"]:
        shutil.copy2(os.path.join(TEMPLATE, rel), os.path.join(out, rel))
    vsrc = os.path.join(TEMPLATE, "vendor")
    vdst = os.path.join(out, "vendor")
    if os.path.isdir(vdst):
        shutil.rmtree(vdst)
    shutil.copytree(vsrc, vdst)

    # 启动脚本（纯 ASCII —— cmd.exe 用 OEM 代码页读 .cmd，非 ASCII 会解析失败）
    with open(os.path.join(out, "start_server.cmd"), "w", encoding="ascii", errors="replace") as f:
        f.write(START_CMD.format(py=sys.executable))

    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(out) for fn in fns)
    print(f"\n✔ 生成完成：{out}   ({len(entries)} 层, 共 {size/1e6:.1f} MB)")
    print("  下一步：")
    print(f"    1) python serve.py 8777        # 在 {out} 里启动")
    print("    2) 浏览器打开 http://127.0.0.1:8777/  （Ctrl+Shift+R 强制刷新）")
    print("    3) 开启摄像头后皮套即跟随；直播模式按 H，全屏按 F")
    if args.check:
        # 跨平台查找 node：优先 PATH，其次 NODE 环境变量。都找不到就跳过自检
        # （不要写死本机绝对路径——那既泄露个人信息，换台机器也会失效）。
        node = shutil.which("node") or os.environ.get("NODE")
        if not node or not os.path.exists(node):
            print("  [!] 找不到 node（PATH 或 NODE 环境变量均未指向可执行文件），跳过行为自检")
            return
        print("\n—— 行为自检 ——")
        r = subprocess.run([node, CHECKER, out], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        print(r.stdout or r.stderr)
        sys.exit(r.returncode)


def render_rig(g, split, ecx, ecy, ls, ld, clip):
    """生成 rig.js：结构 = template/src/rig.js，GEO 与绑定参数换成推导值。"""
    def n(v):
        return int(v) if float(v).is_integer() else round(float(v), 3)
    J = json.dumps

    return f"""/**
 * rig.js — 由 make_avatar.py 自动生成
 * 画布几何集中在 GEO；比例式的标定依据见 skill 的 references/tuning.md。
 * 手工微调可直接改本文件的数值。
 */
export const GEO = {{
  canvas: {J(g['canvas'])},
  cx: {g['cx']},
  pivot: {J(g['pivot'])},
  pivotNorm: {n(g['pivotNorm'])},
  head: {J(g['head'])},
  pitch: {J(g['pitch'])},
  sil: {J(g['sil'])},
  body: {J(g['body'])},
  faceWarp: {J(g['faceWarp'])},
  hairSide: {J(g['hairSide'])},
  brow: {J(g['brow'])},
  neck: {J(g['neck'])},
  collar: {J(g['collar'])},
  src: {J(g['src'])},
}};

export const CANVAS = GEO.canvas;
export const HEAD_PIVOT = GEO.pivot;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const LAYERS = [
  {{
    id: 'neck', file: 'neck.png', z: 0,
    // 可见段近刚体（base≈0.9，点头不伸缩——下巴盖住更多/更少的脖子），
    // 衣领以下才过渡到只跟身体。
    // ⚠ 不能用线性斜坡——末端导数突变会在脖子上留"折点"。
    // ⚠ 上衣必须压在脖子上面（与 PSD 原序一致）。
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {{
        const t = clamp01((y - GEO.neck.y0) / GEO.neck.span);
        return GEO.neck.base - (t * t * (3 - 2 * t)) * GEO.neck.drop;
      }}],
      ['FaceWarp', 0.12],
    ],
    pitchGain: 0.45,
    yawGain: (x, y) => 0.55 - 0.45 * clamp01((y - GEO.neck.y0) / 85),
    mesh: {{ cols: 10, rows: 16 }}, side: 'C',
  }},
  {{
    id: 'topwear_collar', file: 'topwear.png', z: 1.5,
    // 前衣领复制层：同贴图同变形画第二遍，clipRect 只露领口带——
    // 用户指定层序「前衣领压脖子、脖子压后衣领」的等效实现。
    // 两份变形完全一致 ⇒ 重叠区像素相同 ⇒ 裁剪边缘无缝。
    // ⚠ 不要用渐隐（bottomFade）替代：半透明三角形叠在深色高领上
    //   会显出逐三角形接缝（"网格带"，用户实测）。
    clipRect: {{ x: {clip['clip_x']}, y: {clip['clip_y']}, w: {clip['clip_w']}, h: {clip['clip_h']} }},
    pitchGain: 0.08,
    yawGain: 0.1,
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {{
        const t = clamp01((y - GEO.collar.y0) / GEO.collar.span);
        return GEO.collar.base - (t * t * (3 - 2 * t)) * GEO.collar.drop;
      }}],
    ],
    mesh: {{ cols: 16, rows: 16 }}, side: 'C',
  }},
  {{
    id: 'topwear', file: 'topwear.png', z: 1,
    // 上衣**压在脖子上面**（与 See-through PSD 原始层序一致）。
    // 衣领沿高度 smoothstep 渐变：领口跟头多一些，下摆几乎不动。
    warpChain: [
      ['BodyWarp', 1.0],
      ['HeadWarp', (x, y) => {{
        const t = clamp01((y - GEO.collar.y0) / GEO.collar.span);
        return GEO.collar.base - (t * t * (3 - 2 * t)) * GEO.collar.drop;
      }}],
    ],
    pitchGain: 0.08,
    yawGain: 0.1,
    mesh: {{ cols: 16, rows: 16 }}, side: 'C',
    vyFalloff: {{ from: 1.0, to: 0.15 }},
  }},
  {{
    id: 'back_hair', file: 'back_hair.png', z: 2,
    // 权重 0.93 = 图层视差（后发位移略小 => 有厚度）；刻意小，防"两道轮廓"。
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 0.93], ['HairSwayBack', 1.0]],
    mesh: {{ cols: 14, rows: 14 }}, side: 'C',
    swayDelay: 0.85,
  }},
  {{
    id: 'earwear', file: 'earwear.png', z: 3,
    // 刚体吊坠不吃 FaceWarp（带 clamp 的梯度有折点，会压扁网格）。
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['EarRingSway', 1.0]],
    mesh: {{ cols: 6, rows: 14 }}, side: 'R',
    pendulum: {{ pivotY: 0.0, gain: 1.0 }},
    rigid: 0.35,
    yawDepth: -0.6,
  }},
  {{
    id: 'ears', file: 'ears.png', z: 4,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: {{ cols: 10, rows: 6 }}, side: 'C',
    rigid: 0.7,
    yawDepth: -0.5,
  }},
  {{
    id: 'face', file: 'face.png', z: 5,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: {{ cols: 16, rows: 18 }}, side: 'C',
  }},
  {{
    id: 'nose', file: 'nose.png', z: 6,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0]],
    mesh: {{ cols: 4, rows: 5 }}, side: 'C',
    feature: true, rigid: 0.45, yawDepth: 1.0,
  }},
  {{
    id: 'mouth', file: 'mouth.png', z: 7,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['MouthWarp', 1.0]],
    mesh: {{ cols: 10, rows: 8 }}, side: 'C', soft: true,
    feature: true, rigid: 0.5, yawDepth: -0.25,
  }},
  {{
    id: 'eyewhite', file: 'eyewhite.png', z: 8,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    mesh: {{ cols: 12, rows: 6 }}, side: 'LR', soft: true,
    splitAt: {split['eyewhite']},
    eyeRole: 'ball',
    feature: true, rigid: 0.5, yawDepth: -0.45,
  }},
  {{
    id: 'irides', file: 'irides.png', z: 9,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    mesh: {{ cols: 8, rows: 6 }}, side: 'LR', soft: true,
    splitAt: {split['irides']},
    eyeRole: 'ball',
    feature: true, rigid: 0.4, yawDepth: -0.55,
    parallax: 0.9,
    eyeClampX: {ecx},
    eyeClampY: {ecy},
  }},
  {{
    id: 'eyelash', file: 'eyelash.png', z: 10,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['EyeWarp', 1.0]],
    mesh: {{ cols: 20, rows: 16 }}, side: 'LR', soft: true,
    splitAt: {split['eyelash']},
    eyeRole: 'lash',
    lashSplit: {ls},
    lashDrop: {ld},
    feature: true, rigid: 0.5, yawDepth: -0.3,
  }},
  {{
    id: 'eyebrow', file: 'eyebrow.png', z: 11,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['FaceWarp', 1.0], ['BrowWarp', 1.0]],
    mesh: {{ cols: 12, rows: 4 }}, side: 'LR', soft: true,
    splitAt: {split['eyebrow']},
    feature: true, rigid: 0.5, yawDepth: 0.25,
  }},
  {{
    id: 'front_hair', file: 'front_hair.png', z: 12,
    warpChain: [['BodyWarp', 1.0], ['HeadWarp', 1.0], ['HairSwayFront', 1.0]],
    mesh: {{ cols: 16, rows: 16 }}, side: 'C',
    swayDelay: 1.0,
    // 刘海左右碎发量不同时可调（如 {{ L: 0.75, R: 1.35 }}）；默认对称。
    asymmetric: {{ L: 1.0, R: 1.0 }},
  }},
];

export const PARAMS = {{
  angleX:      {{ min: -1, max: 1, def: 0 }},
  angleY:      {{ min: -1, max: 1, def: 0 }},
  angleZ:      {{ min: -1, max: 1, def: 0 }},
  bodyAngleX:  {{ min: -1, max: 1, def: 0 }},
  breath:      {{ min: -1, max: 1, def: 0 }},
  eyeLOpen:    {{ min: 0, max: 1, def: 1 }},
  eyeROpen:    {{ min: 0, max: 1, def: 1 }},
  eyeBallX:    {{ min: -1, max: 1, def: 0 }},
  eyeBallY:    {{ min: -1, max: 1, def: 0 }},
  browLY:      {{ min: -1, max: 1, def: 0 }},
  browRY:      {{ min: -1, max: 1, def: 0 }},
  browAngle:   {{ min: -1, max: 1, def: 0 }},
  mouthOpen:   {{ min: 0, max: 1, def: 0.25 }},
  mouthForm:   {{ min: -1, max: 1, def: 0 }},
  mouthX:      {{ min: -1, max: 1, def: 0 }},
  exprSmile:   {{ min: 0, max: 1, def: 1 }},
  exprLaugh:   {{ min: 0, max: 1, def: 0 }},
  exprBlink:   {{ min: 0, max: 1, def: 0 }},
  exprCalm:    {{ min: 0, max: 1, def: 0 }},
  hairSway:    {{ min: -1, max: 1, def: 0 }},
  hairSwayY:   {{ min: -1, max: 1, def: 0 }},
}};

export const ANGLE_SCALE = {{
  yaw:   26 * Math.PI / 180,
  pitch: 18 * Math.PI / 180,
  roll:  16 * Math.PI / 180,
}};
"""


START_CMD = """@echo off
title Live2D Avatar Preview Server
setlocal
set "PY={py}"
set "DIR=%~dp0"
echo Live2D Avatar - Preview Server
echo Open:  http://127.0.0.1:8777/
echo.
if not exist "%PY%" (
  echo [ERROR] Python not found: %PY%
  pause
  exit /b 1
)
netstat -ano | findstr ":8777 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port 8777 already in use - server may be running.
  echo        Just open http://127.0.0.1:8777/
  pause
  exit /b 0
)
cd /d "%DIR%"
"%PY%" serve.py 8777
echo.
echo Server stopped.
pause
"""


if __name__ == "__main__":
    main()
