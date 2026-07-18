# 贡献指南

## 开发环境

- Windows 10/11 x64
- Node.js 22
- npm

```powershell
npm ci
npm run dev
```

## 提交前验证

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run test:electron
```

完整回归可以直接运行：

```powershell
npm run test:all
```

## 代码边界

- `renderer` 只负责 UI，不直接访问 Node、文件系统、进程、凭据或任意网络。
- `preload` 只暴露具体、带类型、可验证的 IPC 白名单。
- 网络、DPAPI、本地历史、附件和 Agent 工具均保留在 `main`。
- 工具调用只信任经过完整 schema 校验的最终事件；增量事件不能单独触发本地操作。
- endpoint、模型、权限、工作区和附件在每轮开始时固定快照。
- 不得弱化 endpoint 确认、脱敏、路径边界、一次性批准和原子写入检查。

## 禁止提交

- API Key、访问令牌、刷新令牌、Cookie、真实聊天记录和用户数据。
- `node_modules`、`out`、测试报告、安装包、便携包和编译缓存。
- 包含真实账户、额度、本地路径、文件名或掩码凭据后缀的截图。
- 完整生产请求正文、服务器日志、数据库或容器导出物。

完整要求以 [AGENTS.md](AGENTS.md) 为准。
