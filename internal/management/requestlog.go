package management

import (
	"context"
	"net/http"

	"github.com/felixge/httpsnoop"
	"github.com/golang-jwt/jwt/v4"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/rest/httpx"
)

// 框架默认在鉴权失败、5xx 时转储请求，可能泄漏 JWT、设备密钥或 Compose 内容。
// 继续使用框架原有 JWT 解析器和 claims 规则，仅替换会转储凭据的错误输出。
func (m *Manager) authorize(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	secret := m.Context.Config.Auth.AccessSecret
	tok, err := m.parser.ParseToken(r, secret, "")
	if secret == "" || err != nil || tok == nil || !tok.Valid {
		httpx.WriteJson(w, http.StatusUnauthorized, types.Resp{Code: 401, Msg: "未授权，请重新登录", Data: map[string]any{}})
		return r, false
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		httpx.WriteJson(w, http.StatusUnauthorized, types.Resp{Code: 401, Msg: "登录信息无效，请重新登录", Data: map[string]any{}})
		return r, false
	}
	ctx := r.Context()
	for key, value := range claims {
		switch key {
		case "aud", "exp", "jti", "iat", "iss", "nbf", "sub":
			continue
		}
		ctx = context.WithValue(ctx, key, value)
	}
	return r.WithContext(ctx), true
}

// httpsnoop 保留下载和流式响应需要的接口；日志只记录排障元数据，不记录查询串、头或正文。
func RequestLog(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		metrics := httpsnoop.CaptureMetrics(next, w, r)
		logx.WithContext(r.Context()).Infof("HTTP %s %s，状态 %d，耗时 %s", r.Method, r.URL.EscapedPath(), metrics.Code, metrics.Duration)
	}
}
