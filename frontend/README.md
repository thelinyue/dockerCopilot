# Docker Copilot 前端

此目录是 [thelinyue/dockerCopilot](https://github.com/thelinyue/dockerCopilot) 的组成部分，与 Go 后端使用同一个 Git 仓库、分支和提交。不要单独克隆、提交或发布前端仓库。

前端使用 React 18、Vite 5 和 Tailwind CSS。完整环境说明见 [本地开发说明](../DEVELOPMENT.md)。

从仓库根目录运行：

```powershell
.\dev.ps1 setup     # 安装前端和后端依赖
.\dev.ps1 start     # 构建前端并嵌入 Go 后端，启动完整应用
.\dev.ps1 frontend  # 可选：启动前端热更新，连接本机后端
```

不使用 PowerShell 时，可在仓库根目录构建：

```sh
npm --prefix frontend ci
npm --prefix frontend run build -- --outDir ../front
go build -o dockerCopilot .
go test ./...
```

`src/api/client.js` 定义 API 客户端，`src/components/` 存放业务组件。`front/` 和 `frontend/dist/` 都是构建产物，不提交到 Git。前端构建后由 Go 嵌入，部署沿用根目录的统一后端镜像流程，不再单独构建前端镜像或跨仓库触发发布。

应用图标原稿、各用途尺寸和生成提示词见 [图标说明](../docs/BRANDING.md)。

源码来源为 [DongShull/Docker-Copilot-React](https://github.com/DongShull/Docker-Copilot-React)，导入提交为 `263766c39566a356d916fc2167945cfb8aaffd38`。原始历史仍可在上游及个人前端 fork 中查阅。上游 README 标注 MIT，但该快照未提供独立 LICENSE 文件；此处保留来源信息，仓库根目录的 LICENSE 保持原样。
