---
name: live2d-pet
description: 从一份 See-through 已分层的 PSD，生成能直接使用的网页版 Live2D 皮套（本地起服务即用，不开 Cubism Editor）：人脸驱动转头/点头/歪头（非对称位移+近大远小）、眨眼闭眼（睫毛弧线）、眼珠限位、口型表情、头发摆动、耳坠单摆、躯干圆柱跟随、背景图导入、直播模式（隐藏界面）、全屏、存 PNG。输出以经过多轮实测校准的标准品为基准，生成后自动跑行为自检（五官尺寸/网格不塌陷/点头不拉伸/五官间距锁死/眨眼注视幅度）。用于用户给了一份分层 PSD 想直接得到可用的皮套、或想调整已生成皮套的动作幅度与绑定时。Builds a ready-to-use web Live2D avatar (face-driven, streaming-ready) from a See-through layered PSD.
---

# 网页皮套：从 See-through PSD 到可直接使用

输入一份 See-through 分层好的 `.psd`，产出一个**本机直接能开**的 Live2D 皮套（网页版，摄像头人脸驱动）。所有绑定数值都按标准品校准过，生成后自动跑行为自检——**自检不全部 PASS 就不算完成**。

## 第 0 步：环境

Python 与 Node 用本机可用的解释器（下面用占位符，按实际环境替换）：

```
PY   = <Python 可执行文件绝对路径>
NODE = <Node 可执行文件绝对路径>
```

`psd-tools/numpy/Pillow` 需要在 Python 能 import 到的位置；若 pip 受限，可把它们解包到某个本地目录并设：

```
PYTHONPATH = <第三方库目录>
```

缺库时：从 PyPI 下载对应 wheel 用 zipfile 解包进该目录（pip 可用时直接 pip install 更省事）。pyd/pyc 跨平台 wheel 装不得——wheel 的 ABI/平台标签要与本机 Python 匹配，例如 CPython 3.12 / Windows x64 对应 `cp312-cp312-win_amd64`；纯 Python 包用 `py3-none-any`。

## 第 1 步：检查 PSD → 生成

先确认 PSD 里能看到这些图层名（see-through 标准输出，允许空格/大小写差异）：
`neck, topwear, earwear, ears, face, mouth, nose, eyewhite, back hair, eyelash, irides, eyebrow, front hair`。
缺 `face/eyewhite/irides/eyelash/mouth/nose/eyebrow/neck` 任何一个就直接告诉用户缺什么，不要硬生成。

```
python make_avatar.py <输入.psd> <输出目录> --name <角色名> --check
```

脚本会：按名字映射部件 → `topil()` 提取每层 PNG（⚠ 不要改成 `composite()`，那会做层合成把相邻层像素烘进来，实测污染 6905 像素、绑定全部失真）→ 从 alpha 几何推导 splitAt/eyeClamp/lashSplit/lashDrop/GEO → 生成 `src/rig.js` 并拷齐其余文件 → 跑行为自检。

**自检全 PASS 才继续**；有 FAIL 就把输出贴给用户并停下（不要靠改断言凑绿）。

## 第 2 步：起服务（有两条铁律）

1. **必须用 harness 的受管后台任务**（pwsh 工具 `run_in_background: true`，`Set-Location <输出目录>` 后 `& $PY serve.py 8777`）。**不要用 `Start-Process`**——实测它活不过命令结束，这是服务反复掉线的根因。
2. 让用户 **Ctrl+Shift+R** 强刷。页面有蓝色版本号，与 `/build.json` 一致才是新代码（浏览器缓存曾让旧代码存活多轮）。

交付给用户的话术模板：打开 http://127.0.0.1:8777/ → Ctrl+Shift+R → 「开启摄像头」→ 点 H 直播模式、F 全屏、Ctrl+S 存 PNG；面板里可导入背景图（也可直接拖图进画面）。

## 第 3 步：调幅度（用户反馈"太大/太小/不像"时）

读 `references/tuning.md`——那是标准品多轮实测的标定手册：每个系数在哪、调大调小意味着什么、哪些坑已经踩过（别再踩）。改完重跑 `node scripts/check_avatar.mjs <输出目录>`，仍须全 PASS。

## 铁律

- **标准品皮套目录与它的测试集不许动**（本机路径用 `<标准品目录>` 占位，不写死）。那是行为基准；skill 的 template 是它的参数化副本（已验证等价：连同脖子二阶差分 0.000132 都一致）。
- **同一症状修三轮还在，停止改代码**——大角度转头的纸片感是"拉伸正面原画"固有的（Live2D 规则：单张正面原画只做小角度转头，大角度要侧脸素材）。
- 头部姿态已限幅 ±30°（超限停止追踪，HUD 显示"限幅"）——这是故意的，不是 bug。

## 已知限制

- 正面单张原画：转头幅度受限（见上），无侧脸。
- `topwear` 里若画了耳坠（see-through 偶发把同一物件分两层），转头会出现两个耳坠——用 earwear 的 alpha 膨胀 3px 当掩膜把 topwear 里那份擦掉（标准品修过，脚本暂未自动化）。
- 生成器的 splitAt/lash 等推导在标准品 PSD 上与手工值差 ≤2px 或完全一致；换画风差异大的 PSD 后若闭眼/眨眼观感不对，按 tuning.md 手工校 `splitAt/lashSplit/lashDrop`。
