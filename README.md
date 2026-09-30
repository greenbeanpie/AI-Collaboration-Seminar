# 「补位」AI 项目办公室

本仓库包含项目实施计划和一个可直接在浏览器中打开的前端原型。原型使用演示数据和模拟 AI，修改保存在浏览器本地；它尚未连接后端，也不是 `PLAN.md` 中规划的 React、PWA 或 Cloudflare Worker 成品。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `PLAN.md` | 前后端功能、接口及验收计划 |
| `frontend/index.html` | 前端原型入口，包含页面、样式和交互 |
| `frontend/index.html.artifact.json` | 原型工具的入口元数据 |
| `frontend/.file-versions/` | 原型历史版本与清单，供回溯使用 |
| `frontend/.od-frames/` | 设备预览模板，供设计预览使用 |

`frontend/.file-versions/` 和 `frontend/.od-frames/` 是原型辅助文件，不属于部署页面。根目录的 `LICENSE` 为授权文件。

## 本地预览

在仓库根目录运行：

```sh
python3 -m http.server 8000 --directory frontend
```

然后打开 <http://localhost:8000/>。原型不需要安装依赖或执行构建。浏览器会将演示修改保存在本地存储中；可在原型的设置页重置。

## 部署页面

本仓库目前没有 Worker 配置。若使用单独维护的 Cloudflare Worker 项目，仅复制 `frontend/index.html` 到该项目的静态资源目录，并在目标项目内执行其部署和验证流程。不要将原型的版本记录或设备预览模板一并作为站点资源部署。
