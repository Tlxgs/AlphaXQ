# 中国象棋 · 浏览器版

纯静态网页，人执红，对战 693-256-192-96 的 MLP 价值网络，固定深度 3。
点击棋子，再点落点即可。

## 本地运行

ES Module 和模型文件需要通过 HTTP 读取，不要直接双击 `index.html`：

```bash
python -m http.server 8000
```

然后打开 `http://localhost:8000`。

## 发布到 GitHub Pages

1. 把整个 `xiangqi_web` 目录上传到 GitHub 仓库。
2. 仓库 Settings → Pages → Deploy from a branch。
3. 选择分支，目录选 `/ (root)`（或把本目录放到 `docs/` 后选 `/docs`）。

所有资源都是相对路径，不需要构建。

## 模型

权重来自项目最新的 `xiangqi_ai/models/epoch_1230.pt`，导出为
`model/values.bin` + `model/meta.json`。重新导出：

```bash
cd xiangqi_ai
..\venv\Scripts\python.exe export_web_model.py
```
