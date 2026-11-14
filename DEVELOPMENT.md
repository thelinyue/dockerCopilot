# 本地二次开发

前后端统一在 [thelinyue/dockerCopilot](https://github.com/thelinyue/dockerCopilot) 中开发。React 前端位于 `frontend/`，Go / go-zero 后端位于根目录和 `internal/`；两者使用同一个分支、提交和远端。

## 首次准备

```powershell
git clone https://github.com/thelinyue/dockerCopilot.git
cd dockerCopilot
.\dev.ps1 setup
.\dev.ps1 start
```

Windows 使用本机 Go、Node.js 和 npm，运行后端使用 WSL2 Debian 的 Docker Engine 和 Compose，不要求 Docker Desktop。Go 最低版本为 1.23.0，`go.mod` 推荐工具链 1.24.1，CI 前端使用 Node.js 22。

`setup` 安装 `frontend/package-lock.json` 锁定的 npm 依赖、下载 Go 模块，并在 `.local/compose.env` 生成登录密钥。它不会再克隆或初始化独立前端仓库。

开发镜像使用本机已有的 `debian:bookworm-slim`，从 Debian WSL 复制公开 CA 证书用于 HTTPS。新机器应先确认 WSL Debian 中的 Docker 可用，且存在该基础镜像；没有时需先执行 `wsl -d Debian --exec docker pull debian:bookworm-slim`。

## 开发和验证

```powershell
.\dev.ps1 start     # 构建前端、编译 Linux amd64 后端并启动开发容器
.\dev.ps1 frontend  # 可选：另开终端启动前端热更新，Ctrl+C 停止
.\dev.ps1 build     # 仅构建，不启动
.\dev.ps1 test      # 运行后端测试，首次使用需先完成 build/start
.\dev.ps1 status    # 查看开发容器
.\dev.ps1 logs      # 查看日志，Ctrl+C 退出
.\dev.ps1 stop      # 移除本项目开发容器及网络，保留本地数据
git status         # 同时查看前后端改动
```

- 完整应用：<http://127.0.0.1:12712/manager>。
- 前端热更新：<http://127.0.0.1:12713>，脚本临时设置 API 指向本机 12712，不写入生产构建。
- 登录密钥：`.local/compose.env` 中 `secretKey=` 后面的值，不提交到 Git。
- 修改后端后再次运行 `start`；前端热更新保存即生效，嵌入后端的页面需重新运行 `start` 更新。

**Docker 操作边界：** 开发容器挂载 Debian 的 `/var/run/docker.sock`，可以管理该引擎中的全部容器和镜像。联调前核对目标，避免对其他项目执行启停、更新、删除或恢复操作。端口只绑定本机 `127.0.0.1`。

不使用 PowerShell 时，在根目录按顺序构建即可，不需要额外克隆前端：

```sh
npm --prefix frontend ci
npm --prefix frontend run build -- --outDir ../front
go build -o dockerCopilot .
go test ./...
```

原有发布工作流现直接检出本仓库当前提交，执行 `frontend/` 中的 `npm ci` 和 `npm run build`，再将产物嵌入 Go 程序。七个发布工作流均使用同一份前端，不再依赖跨仓库令牌。原有发布分支、版本文件触发条件及 Docker Hub secrets 要求沿用现状；本次仓库合并不发布新版本。

## 目录与版本管理

| 路径 | 用途 |
| --- | --- |
| `dockercopilot.go` | 服务启动、静态页面嵌入与路由 |
| `dockercopilot.api` | go-zero API 定义 |
| `internal/handler` | HTTP 请求处理 |
| `internal/logic` | 业务逻辑 |
| `internal/utiles` | Docker、备份与更新工具 |
| `frontend/src` | React 前端源码 |
| `frontend/package-lock.json` | 前端依赖锁文件 |
| `front/` | Go embed 使用的前端产物，忽略提交 |
| `frontend/dist/` | CI 的前端构建产物，忽略提交 |
| `.local/bin` | Linux 开发二进制 |
| `.local/data` | 开发配置、图标、备份数据 |
| `.local/logs` | 开发日志 |

根目录 `origin` 为个人仓库，`upstream` 保留 `onlyLTY/dockerCopilot`。后续前后端修改都在根目录审查和提交，不再分别进入两个仓库。Go module 路径保持原值，避免无关的导入重命名。

前端导入来源为 [DongShull/Docker-Copilot-React](https://github.com/DongShull/Docker-Copilot-React) 的 `263766c39566a356d916fc2167945cfb8aaffd38`；业务源码和锁文件保持该快照的内容。前端 Git 元数据、迁移前本地补丁及原 README 保留在本机忽略目录 `.local/frontend-migration/`，可以追溯原始历史，但不纳入新仓库。之前创建的个人前端 fork 保留，不再用于当前开发和构建。

仓库保留根目录 AGPL-3.0 LICENSE；前端来源与上游许可标注见 [frontend/README.md](frontend/README.md)。

## 已知限制

- 上游前后端存在部分接口差异。例如前端备份恢复请求为 `/api/container/backups/:filename/restore`，后端为 `/api/container/backups/restore`。本次只合并仓库，不夹带业务修复。
- 前端热更新服务不提供后端自定义图标文件路由，图标功能在完整应用地址联调。
- 应用内置更新源仍指向上游，发布二次开发版本前需单独适配。
- 本机 Docker 拉取镜像曾因现有代理 `127.0.0.1:7897` 超时失败；缓存基础镜像可用于开发构建。拉取新镜像或测试容器更新前应检查引擎代理连通性。
- Vite 提示浏览器兼容性数据较旧，不影响构建；本次未升级依赖。
