# 2026-06-05 本地优先桌面版与手机同步计划

## 目标

把当前网页记事本升级为可持续演进的软件项目：

- Windows 桌面版可作为普通软件启动。
- 当前网页功能继续可用。
- 后端提供稳定的局域网同步接口。
- 手机 App 工程具备连接电脑、拉取数据、保存本地缓存的基础。

## 约束

- 不删除现有记录。
- 不改变 `notes.json` 的主要结构。
- 不要求立刻完成公网云同步。
- 本轮优先完成可运行底座，不一次性重写整个 UI。

## 实施步骤

1. 项目整理
   - 建立 `docs`、`desktop`、`mobile` 目录。
   - 写清楚架构和同步策略。

2. 后端同步接口
   - 新增 `sync-meta.json`。
   - 新增 `/api/sync/state`。
   - 新增 `/api/sync/pull`。
   - 新增 `/api/sync/push`。
   - 对旧记录补齐兼容的 `updatedAt`。

3. Windows 桌面版
   - 建立 Electron 壳工程。
   - 启动时拉起 `E:\SyncNotes\web\server\server.js`。
   - 窗口打开本地地址。
   - 提供 `start-desktop.bat`。

4. 手机 App 原型
   - 建立轻量移动端 Web App 工程。
   - 支持填写电脑地址和账号密码。
   - 支持拉取记录列表并缓存到手机端 localStorage。
   - Android 原生打包等 SDK 准备好后再接入。

5. 验证
   - 检查 `server.js` 语法。
   - 检查前端脚本语法。
   - 验证本地服务 HTTP 200。
   - 验证新增同步接口返回正常。

## 完成标准

- `E:\SyncNotes\app` 仍可正常打开。
- `E:\SyncNotes\exe\desktop-project` 有可启动桌面壳工程。
- `E:\SyncNotes\app\mobile-web` 有手机端同步原型。
- 同步接口可以返回记录和草稿。
- 用户当前数据不丢失。
