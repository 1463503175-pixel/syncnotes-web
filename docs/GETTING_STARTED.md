# SyncNotes · 快速上手

[返回项目首页](../README.md) / Getting started

SyncNotes 是一个以本地存储为核心的笔记项目。本仓库既包含 **Node.js 网页端源码**，也保留了历史 **Windows 桌面发布包**；两种使用方法请不要混淆。

## 选择使用方式

| 我想要 | 推荐入口 | 说明 |
|---|---|---|
| 直接在 Windows 上体验桌面程序 | [Windows v1.1.7 发布页](https://github.com/1463503175-pixel/syncnotes-web/releases/tag/v1.1.7) | 从 Release 下载 Windows ZIP，解压后按发布说明启动 |
| 从源码运行网页服务 | [server.js](../server.js) | 需要本机 Node.js，按下述步骤打开本地网页 |
| 查看程序界面源码 | [public/index.html](../public/index.html) | 当前网页版为原生 HTML/CSS/JavaScript |
| 了解旧版桌面安装说明 | [Windows EXE 使用说明](../releases/1.1.7/Chen-Dushan-Notes-EXE-使用说明.md) | 对应 v1.1.7，未必与当前 main 的网页源码功能完全相同 |

> **关于版本：** Release v1.1.7 是仓库中可核实的 Windows 发行版；main 分支源码可能已更新。请勿把桌面旧发行版和当前网页源码的功能完全等同。

## 方法一：直接运行 Windows 桌面版

1. 打开 [Windows v1.1.7 发布页](https://github.com/1463503175-pixel/syncnotes-web/releases/tag/v1.1.7)。
2. 下载 `Chen-Dushan-Notes-1.1.7-Windows.zip` 并解压。
3. 依照 ZIP 内的说明启动程序；初次设置本地账号、密码及数据存放位置。
4. 进入程序后，记录笔记、添加附件；如需 AI 功能，在设置中配置个人 API。

桌面旧发行版与当前仓库源码不是同一套打包流程。升级前先备份笔记及附件数据。

## 方法二：从源码启动网页端

### 1. 获取源码与 Node.js

克隆项目：

```bash
git clone https://github.com/1463503175-pixel/syncnotes-web.git
cd syncnotes-web
```

确保安装了 Node.js。在项目目录直接启动：

```bash
node server.js
```

浏览器打开：

```text
http://localhost:8765
```

项目包含原生 Node.js HTTP 服务，不要求先启动独立数据库。

### 2. 配置数据保存位置

当前源码默认使用 Windows 上的 `E:\SyncNotes\web\data` 及 `E:\SyncNotes\web\attachments`。**其他计算机建议先设置独立保存位置，避免默认路径不存在或无法写入。**

将 `.env.example` 复制为 `.env.local`，按自己的路径设置：

```dotenv
PORT=8765
SYNC_NOTES_DATA_DIR=D:\MySyncNotes\data
SYNC_NOTES_ATTACHMENTS_DIR=D:\MySyncNotes\attachments
```

以上路径只是示例，请替换成实际存在、具有写入权限的位置。

### 3. 可选功能

- **附件：** 可以保存图片、音频、视频与文档；具体媒体处理可能依赖本机 FFmpeg 或 Python 环境。
- **AI：** 通过 `.env.local` 设置 `AI_BASE_URL`、`AI_API_KEY` 等参数；没有配置时，不应假定 AI 接口可用。
- **设备同步：** 服务端包含同步接口，但移动客户端与 Windows 桌面安装包并未完整包含在本仓库的 main 源码中。跨设备使用还需要客户端和网络配置。

## 认识界面

| 模块 | 用途 |
|---|---|
| **笔记时间轴** | 浏览、整理不同日期的记录 |
| **编辑区** | 编写内容、管理附件、调整笔记 |
| **概览与工具区** | 日常信息、辅助功能、搜索与管理入口 |
| **设置** | 主题、相关选项及可选 AI 接口配置 |

网页主界面采用多列布局，实际选项可能随当前代码和运行配置变化。首页展示的 UI 视觉图为 **概念插画，不是实机截图**。

## 数据、隐私和备份

默认在本地文件夹保存个人数据。尤其需要备份：

```text
data/                 笔记、草稿、同步状态、访问配置
attachments/          图片、音频、视频、文档等
.env.local            本地配置与可能存在的密钥
```

这些文件可能包含个人隐私或 API Key。**不要提交到公开 GitHub 仓库。** Git 不等于个人数据备份：迁移电脑或升级之前，应在安全位置备份完整数据目录。

> **网络安全提醒：** 本地保存并不等于自动具备互联网安全防护。不要把开发版服务直接暴露到公网；如果在局域网访问，先核对账号认证、监听地址、网络权限和客户端连接方式。

## 常见问题

<details>
<summary>浏览器打不开 localhost:8765</summary>

检查 Node.js 是否启动、终端是否有报错、8765 端口是否被占用，以及 `PORT` 配置是否已修改。
</details>

<details>
<summary>为什么双击旧启动脚本找不到 Node.js？</summary>

现有部分 Windows 启动脚本仍使用特定的开发环境绝对路径，并非通用安装脚本。跨设备运行时优先在项目目录执行 `node server.js`。
</details>

<details>
<summary>AI 功能无法使用</summary>

确认已自行配置可用的 API 地址、密钥、模型，并检查当前网络及接口支持情况。仓库没有附带公共可用的 AI Key。
</details>

<details>
<summary>为什么找不到 Android APK？</summary>

当前 GitHub `syncnotes-web` 仓库并未包含完整 Android 工程或 APK。网页端的同步接口不等同于已经随仓库提供手机安装包。
</details>

---

[返回 SyncNotes 首页](../README.md) · [Windows 发行版](https://github.com/1463503175-pixel/syncnotes-web/releases/tag/v1.1.7) · [MIT License](../LICENSE)
