# dockerCopilot
<a href="https://www.gnu.org/licenses/agpl-3.0.en.html">
    <img alt="License: AGPLv3" src="https://shields.io/badge/License-AGPL%20v3-blue.svg">
  </a>

# 介绍

一个主打便捷的docker容器管理工具，现在已经支持所有平台。
已经实现：
1. 一键更新容器
2. 指定镜像和tag更新
3. 启动、停止、重启容器
4. 重命名容器
5. 删除无TAG镜像
6. 删除未使用镜像
7. 更新进度查看
8. 备份容器设置
9. 恢复容器设置

## 使用

docker compose 安装

```
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
    environment:
      - TZ=Asia/Shanghai
      - DOCKER_HOST=unix:///var/run/docker.sock
      - secretKey=密码，不少于八位且非纯数字
    image: 0nlylty/dockercopilot:latest
```

## 开发环境

本仓库统一管理前后端：`frontend/` 为 React 前端，根目录和 `internal/` 为 Go 后端。只需克隆 [thelinyue/dockerCopilot](https://github.com/thelinyue/dockerCopilot)，不需要额外克隆前端仓库。

Go 版本要求以 `go.mod` 为准：最低 1.23.0，推荐工具链 1.24.1。

Windows / WSL 的前后端环境准备、启动和联调方法见 [本地开发说明](DEVELOPMENT.md)。

