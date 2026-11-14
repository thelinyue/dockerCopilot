package management

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/core/logx"
)

func signedTestToken(t *testing.T, secret string, expiry time.Time) string {
	t.Helper()
	v, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": expiry.Unix(), "tenant": "demo"}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRequestLogsNeverDumpCredentials(t *testing.T) {
	var record bytes.Buffer
	logx.SetWriter(logx.NewWriter(&record))
	t.Cleanup(func() { logx.SetWriter(logx.NewWriter(os.Stderr)) })
	cfg := config.Config{}
	cfg.Auth.AccessSecret = "local-test-secret"
	m := New(&svc.ServiceContext{Config: cfg})
	valid := signedTestToken(t, cfg.Auth.AccessSecret, time.Now().Add(time.Hour))
	expired := signedTestToken(t, cfg.Auth.AccessSecret, time.Now().Add(-time.Hour))
	none, err := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		token      string
		authorized bool
	}{{valid, true}, {expired, false}, {"malformed-header-token", false}, {none, false}, {"", false}} {
		called := false
		handler := m.Wrap(func(w http.ResponseWriter, r *http.Request) {
			called = true
			body, _ := io.ReadAll(r.Body)
			if string(body) != `{"secret":"body-sensitive"}` || r.Context().Value("tenant") != "demo" {
				t.Error("合法请求配置或 claims 丢失")
			}
			w.WriteHeader(502)
		})
		req := httptest.NewRequest("POST", "/api/test?secret=query-sensitive", strings.NewReader(`{"secret":"body-sensitive"}`))
		req.Header.Set("Authorization", "Bearer "+item.token)
		req.Header.Set("Cookie", "cookie-sensitive")
		if !item.authorized {
			req.Header.Set(node.DeviceHeader, "unknown-device")
		}
		recorder := httptest.NewRecorder()
		handler(recorder, req)
		want := 401
		if item.authorized {
			want = 502
		}
		if called != item.authorized || recorder.Code != want {
			t.Fatal("鉴权或转发顺序异常", called, recorder.Code)
		}
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("认证业务响应不得被缓存")
		}
	}
	logs := record.String()
	for _, secret := range []string{valid, expired, none, "body-sensitive", "query-sensitive", "cookie-sensitive", "malformed-header-token"} {
		if strings.Contains(logs, secret) {
			t.Fatal("凭据进入日志")
		}
	}
	if !strings.Contains(logs, "/api/test") || !strings.Contains(logs, "502") || !strings.Contains(logs, "401") {
		t.Fatal("排障元数据丢失")
	}
}
