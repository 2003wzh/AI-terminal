# AI终点站 Electron

AI终点站是一个面向 Windows 的 Electron + React + TypeScript AI 工作区。本仓库只包含 Electron 客户端源码，不包含旧 Qt/QML 客户端、`node_modules`、编译输出、便携包或本机数据。

当前版本：`0.1.2`

## 功能

- Chat 与 Agent 双模式工作区。
- Markdown 流式对话、文件和图片附件。
- 动态模型目录、模型分组和推理强度。
- 请求批准、替我审批、完全访问三档权限。
- 工作区读取、搜索、Git 摘要、原子写入和精确替换。
- 任务历史、归档、删除、代码预览和环境信息。
- 设备码登录、账户额度、用量和中转站令牌管理。
- DPAPI 加密、endpoint 确认、共享脱敏和一次性能力 token。

## 开发

运行客户端需要 Windows 10/11 x64、Node.js 22 和 npm。

```powershell
npm ci
npm run dev
```

只启动 React 渲染层：

```powershell
npm run dev:web
```

此模式没有 Electron Main/Preload，也不会连接模型或执行 Chat/Agent；完整功能请使用 `npm run dev`。

## 测试

完整测试另外需要 Python 3 和 Microsoft Edge。也可以通过
`PLAYWRIGHT_BROWSER_CHANNEL` 指定已安装的 Playwright 浏览器通道。

```powershell
npm run test:all
```

完整测试包含安全、服务、运行时、中转站、Playwright E2E、生产构建和 Electron 启动 smoke。

## 构建

```powershell
npm run dist
```

产物写入 `electron_publish/`，该目录不会提交到源码仓库。

## 源码结构

```text
src/
|-- main/       # 网络、加密存储、本地工具、审批和业务服务
|-- preload/    # 固定且带类型的 IPC 白名单
|-- renderer/   # React UI；无 Node、文件系统和凭据访问
`-- shared/     # 跨进程契约、事件验证器和公共配置

tests/
|-- security/   # 加密、脱敏、批准、路径和能力边界
|-- services/   # Chat、Agent、Responses、附件和工作区工具
|-- relay/      # 中转站协议、额度、身份和凭据存储
|-- runtime/    # Sidecar、回合注册、取消和生命周期
|-- e2e/        # React 交互与响应式布局
`-- electron/   # 隔离环境中的真实 Electron smoke
```

## 默认中转站

默认产品配置连接 `https://www.wzhxiaozhan.top`，模型入口为 `/v1`。这不是硬性协议限制；其他 OpenAI-compatible HTTPS endpoint 必须先由用户确认精确地址，随后才会请求模型目录或发送对话。

本仓库不包含中转站或网站服务端源码。登录、账户、额度、令牌、模型目录和在线 Chat/Agent 均依赖上述远端服务及其公开客户端协议；服务端不可用时，客户端会保持可操作的错误与重试状态，不会伪造在线数据。

## 安全

安全规则详见 [AGENTS.md](AGENTS.md)，开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心边界包括：

- API Key 和刷新令牌不返回 Renderer，并使用当前 Windows 用户 DPAPI 加密持久化。
- 非回环 endpoint 只允许 HTTPS，每次应用启动后的首次请求需要精确地址确认。
- 绝对工作区路径保留在本机，模型工具使用工作区相对路径。
- 所有工具调用均经过一次性批准和参数绑定；完全访问不关闭凭据与路径硬边界。
- 日志、错误、工具结果、模型上下文和本地历史经过共享脱敏层。

UI 参考了 CodexMonitor 的部分视觉方向；第三方许可保存在 [src/renderer/CODEXMONITOR_LICENSE.txt](src/renderer/CODEXMONITOR_LICENSE.txt)。

本项目当前未声明开源许可证，源码公开不等于授予再分发许可。
