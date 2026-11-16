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

开发镜像使用本机已有的 `debian:bookworm-slim`，从 Debian WSL 复制公开 CA 证书、官方 Docker CLI 和 Compose 插件，不复制 Docker 登录配置。新机器应先确认 WSL Debian 中的 Docker 和 Compose 可用，且存在该基础镜像；没有时需先执行 `wsl -d Debian --exec docker pull debian:bookworm-slim`。

## 开发和验证

```powershell
.\dev.ps1 start     # 构建前端、按 WSL 的 amd64/arm64 架构编译后端并启动开发容器
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
| `internal/utiles` | Docker 操作与更新恢复工具 |
| `frontend/src` | React 前端源码 |
| `frontend/package-lock.json` | 前端依赖锁文件 |
| `front/` | Go embed 使用的前端产物，忽略提交 |
| `frontend/dist/` | CI 的前端构建产物，忽略提交 |
| `.local/bin` | Linux 开发二进制 |
| `.local/data` | 开发配置、图标及历史数据 |
| `.local/logs` | 开发日志 |

根目录 `origin` 为个人仓库，`upstream` 保留 `onlyLTY/dockerCopilot`。后续前后端修改都在根目录审查和提交，不再分别进入两个仓库。Go module 路径保持原值，避免无关的导入重命名。

前端导入来源为 [DongShull/Docker-Copilot-React](https://github.com/DongShull/Docker-Copilot-React) 的 `263766c39566a356d916fc2167945cfb8aaffd38`；业务源码和锁文件保持该快照的内容。前端 Git 元数据、迁移前本地补丁及原 README 保留在本机忽略目录 `.local/frontend-migration/`，可以追溯原始历史，但不纳入新仓库。之前创建的个人前端 fork 保留，不再用于当前开发和构建。

仓库保留根目录 AGPL-3.0 LICENSE；前端来源与上游许可标注见 [frontend/README.md](frontend/README.md)。

## 管理功能开发与验证

使用方式和挂载示例见 [管理功能说明](docs/MANAGEMENT.md)。开发容器默认没有挂载宿主机项目目录；需要测试 Compose 编辑时，在 `dev/compose.yaml` 增加 `COMPOSE_ROOT` 和相同绝对路径的读写挂载，再重新创建开发容器。不能用宿主机目录挂到容器不同路径来测试相对卷。

新增节点接口在 `internal/management/http.go` 手动注册，旧业务路由经管理器包装后，先用 go-zero 原有 JWT 解析器认证，再按设备转发。框架默认鉴权/5xx 日志会转储请求，入口禁用其请求日志，由包装器只记录方法、路径、状态和耗时，避免泄漏密钥、JWT 和 Compose 内容。重新生成 goctl 路由时应保留包装层及管理器注册，不叠加会转储请求的鉴权中间件。对象操作通过 `RunTask` 的资源范围或 `AcquireContainer` 取得锁：不同项目和独立容器共享节点读锁，同一项目及其容器互斥，独立容器同时锁定实际 ID 和名称以覆盖替换、改名。配置保存还锁定实际文件路径；接管记录只在读改写时串行。镜像删除、清理和程序升级使用节点写锁，升级成功到退出前拒绝新变更。检测及自动更新使用各自的重复执行保护，自动更新只在处理当前对象时取得对象锁。

```sh
go test ./...
npm --prefix frontend test
go test -race ./internal/node ./internal/module ./internal/svc ./internal/management ./internal/handler ./internal/utiles
npm --prefix frontend run build -- --outDir ../front
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/dockerCopilot-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/dockerCopilot-arm64 .
DOCKERCOPILOT_PROGRAM_FIXTURE=/tmp/dockerCopilot-amd64 DOCKERCOPILOT_PROGRAM_ARCH=amd64 \
  go test ./internal/utiles -run TestProgramBuiltArtifact -v
```

并发检查在有 C 编译器的 Linux/WSL 环境运行。普通 Go 测试覆盖代理、TLS、平台选择、设置重启恢复、设备认证和不重试、文件安全与冲突、对象并发、别名互斥、节点独占、异常释放、旧镜像安全清理及有界记录；真实 Docker 测试默认跳过，需要显式指定独立 daemon：

```sh
DOCKERCOPILOT_INTEGRATION_HOST=unix:///var/tmp/dockercopilot-it-example/docker.sock \
  go test ./internal/management -run '^TestIsolated(DockerLifecycle|ConcurrentOperationsAndCleanup)$' -v -timeout 12m
```

项目编辑器的草稿检查另有官方 CLI 测试，不执行容器变更或镜像拉取。它通过本地模拟 Docker 列表发现临时项目，再以 stdin 运行实际 `docker compose config --quiet`，覆盖 JSON override、有序多文件、`.env`、`env_file`、相对卷及中文错误；未显式开启时跳过：

```sh
DOCKERCOPILOT_COMPOSE_TEST=1 go test ./internal/management -run '^TestComposeDraftOfficialConfig$' -v
```

该 daemon 的 data-root 必须位于 `/var/tmp/dockercopilot-it-` 前缀的独立目录，使用独立 exec-root、socket 和 containerd namespace，不能指向现有开发或生产引擎。需要该独立引擎预先缓存 `debian:bookworm-slim`，测试会在其中构建本地 fixture 和临时离线 registry，不从公网拉取镜像。测试覆盖普通容器及 Compose 成功替换、启动失败、健康失败、运行快照恢复、匿名卷和网络保留，并核对 `.env`、env_file、相对卷、JSON override 的官方解析及多副本排除。双实例验收需给两实例各自的数据目录、端口、项目挂载和 Docker socket，核对远端文件、任务、上传下载与主容器离线后的本地定时执行。

镜像清理另有 `TestIsolatedImagePrune`，需要全新的空白独立 daemon，不需要缓存基础镜像。在 Linux/WSL 编译静态运行 fixture 后执行（`GOARCH` 按测试引擎架构调整）：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/copilot-prune-runner ./internal/management/testdata/prune-runner
DOCKERCOPILOT_INTEGRATION_HOST=unix:///var/tmp/dockercopilot-it-prune-example/docker.sock \
DOCKERCOPILOT_PRUNE_RUNNER=/tmp/copilot-prune-runner \
  go test ./internal/management -run '^TestIsolatedImagePrune$' -v -timeout 3m
```

跨架构编译或打包检查不等同于 arm64 真机运行；模拟 HTTP、隔离容器运行与实际设备验收应分别记录。正式 Release 下载和程序替换验收需要已有合适的本仓库正式资源。

## 已知限制

- 手动备份和从备份恢复功能已移除；历史文件保留，数据备份由宿主机处理。更新失败恢复仍使用实际运行配置。自定义图标通过 API 按设备认证加载，可在前端热更新环境联调。
- 内置程序更新源已改为本仓库正式 Release；开发版仅支持通过构建或容器镜像更新。
- 本机 Docker 拉取镜像曾因现有代理 `127.0.0.1:7897` 超时失败；缓存基础镜像可用于开发构建。拉取新镜像或测试容器更新前应检查引擎代理连通性。
- Vite 提示浏览器兼容性数据较旧，不影响构建；本次未升级依赖。
