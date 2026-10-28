# 按图片内容哈希索引的 fixture

`@cabinhug/tools` 的 fake 视觉 provider（`CABINHUG_VISION=fake`）按图片字节的 sha256 前 8 位取 `<sha8>.json`，
内容与上一级目录的整图观察 fixture 同形（frame + items 含描述子与 bbox）。
新增照片时：`node -e` 算 sha8，把对应模型的 fixture 复制过来。`b376235b.json` 对应单测用的合成图
`../synthetic-dashboard.png`：该图由 `../make-synthetic-dashboard.py` 按这份 fixture 的框画色块生成。
