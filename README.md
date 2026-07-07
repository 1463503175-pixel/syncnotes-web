# SyncNotes Web

陈笃山记事本的网页端源码。

这个仓库包含本地网页服务、电脑端网页界面、启动脚本、迁移脚本和项目说明。真实笔记数据、上传附件和本地私密配置没有上传。

## 目录说明

- `server.js`：本地 Node.js HTTP 服务，负责网页、上传、同步、AI、天气和数据读写。
- `public/index.html`：电脑端网页界面。
- `tools/extract_attachment_text.py`：附件文本提取工具。
- `scripts/`：Windows 本地启动脚本。
- `docs/`：设计说明和历史计划。
- `migrate-attachments-to-files.js`：旧附件数据迁移脚本。
- `migrate-videos-to-mp4.js`：旧视频迁移脚本。

## 本地运行

需要 Node.js。进入本目录后运行：

```powershell
node server.js
```

默认访问地址：

```text
http://localhost:8765
```

## 本地数据

运行时会使用以下目录，默认不会提交到 GitHub：

- `data/`：笔记、草稿、访问配置和同步状态。
- `attachments/`：上传的图片、视频、音频、文档等附件。
- `.env.local`：AI 接口、Key 和模型等本地私密配置。

可以参考 `.env.example` 创建自己的 `.env.local`。

## 注意

请不要把真实的 `data/`、`attachments/` 或 `.env.local` 提交到公开仓库。
