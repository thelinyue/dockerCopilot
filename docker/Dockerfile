# 使用 Alpine 作为基础镜像
FROM alpine
LABEL authors="onlyLTY"
WORKDIR /app

ARG TARGETPLATFORM

COPY dc-back/dist/$TARGETPLATFORM/dockerCopilot ./dockerCopilot
COPY dc-back/etc/. ./etc
COPY start.sh ./start.sh

RUN apk add --no-cache tzdata ca-certificates docker-cli docker-cli-compose \
    && chmod +x start.sh \
    && chmod +x dockerCopilot

# 设置环境变量
ENV secretKey="" \
    DOCKER_HOST="unix:///var/run/docker.sock" \
    TZ="Asia/Shanghai"

VOLUME ["/data"]
# 设置启动命令
CMD ["./start.sh"]
