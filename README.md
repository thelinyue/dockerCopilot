# dockerCopilot
<a href="https://www.gnu.org/licenses/agpl-3.0.en.html">
    <img alt="License: AGPLv3" src="https://shields.io/badge/License-AGPL%20v3-blue.svg">
  </a>

# 介绍

一个面向自托管设备的 Docker 容器管理工具，前后端在本仓库统一开发。
已经实现：
1. 一键更新容器
2. 指定镜像和tag更新
3. 启动、停止、重启容器
4. 重命名容器
5. 删除无TAG镜像
6. 删除未使用镜像
7. 更新进度查看
8. 定时检测镜像更新、全局自动更新与排除规则
9. 通过界面设置网络代理、独立容器保留策略和 GitHub 加速地址
10. 项目接管、原文编辑、自动检查、部署及失败恢复
11. 项目、服务与所属容器双向跳转
12. 多设备切换，统一管理远端容器、镜像、图标、项目与定时计划

## 使用

docker compose 安装

```yaml
services:
  dockercopilot:
    container_name: dockercopilot
    restart: always
    privileged: true
    network_mode: bridge
    ports:
      - 12712:12712
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - /srv/compose:/srv/compose:rw
    environment:
      - TZ=Asia/Shanghai
      - DOCKER_HOST=unix:///var/run/docker.sock
      - secretKey=密码，不少于八位且非纯数字
      - COMPOSE_ROOT=/srv/compose
    image: ${DOCKERCOPILOT_IMAGE:?请设置本仓库构建的镜像地址和版本}
```

先设置 `DOCKERCOPILOT_IMAGE` 为本仓库构建的镜像；上游旧镜像不包含本次新增能力。新增功能需要重新构建或升级完整容器镜像，以安装官方 Docker CLI 和 Compose 插件。

`/srv/compose` 可替换为你的项目目录，宿主机与容器内使用相同绝对路径并以读写方式挂载。每台受管设备分别挂载自己的目录。修改挂载后需要重新创建该设备的 DockerCopilot 容器。

自动更新默认关闭，检测默认在启动时及每小时第 30 分钟执行。使用、目录挂载、代理边界、恢复行为及多设备接入详见 [管理功能说明](docs/MANAGEMENT.md)。

运行选项统一在「设置 → 更新设置」修改，保存后无需重启。旧部署中的 `HTTP_PROXY`、`HTTPS_PROXY`、`DelOldContainer`、`githubProxy` 仅在对应持久化字段缺失时迁移一次，之后可从 Compose 删除；已经保存的空值和关闭状态不会被旧环境变量覆盖。

## 开发环境

本仓库统一管理前后端：`frontend/` 为 React 前端，根目录和 `internal/` 为 Go 后端。只需克隆 [thelinyue/dockerCopilot](https://github.com/thelinyue/dockerCopilot)，不需要额外克隆前端仓库。

Go 版本要求以 `go.mod` 为准：最低 1.23.0，推荐工具链 1.24.1。

Windows / WSL 的前后端环境准备、启动和联调方法见 [本地开发说明](DEVELOPMENT.md)。

