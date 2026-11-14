FROM debian:bookworm-slim

# 使用 WSL 已有的公开 CA 证书，开发构建无需安装软件或改动 Docker 的全局代理。
COPY .local/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY .local/bin/docker /usr/local/bin/docker
COPY .local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /app
COPY .local/bin/dockerCopilot /app/dockerCopilot
COPY etc/dockerCopilot.yaml /app/etc/dockerCopilot.yaml
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh /app/dockerCopilot /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-compose
ENTRYPOINT ["/app/start.sh"]
