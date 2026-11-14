FROM debian:bookworm-slim

# 使用 WSL 已有的公开 CA 证书，开发构建无需安装软件或改动 Docker 的全局代理。
COPY .local/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY .local/bin/dockerCopilot /app/dockerCopilot
COPY etc/dockerCopilot.yaml /app/etc/dockerCopilot.yaml
ENTRYPOINT ["/app/dockerCopilot"]
