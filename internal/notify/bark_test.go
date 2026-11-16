package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

func TestBarkJSONPrefixAndResponseErrors(t *testing.T) {
	for _, test := range []struct {
		name, response string
		status         int
		want           string
	}{
		{"success", `{"code":200}`, 200, ""},
		{"business-error", `{"code":400,"message":"private-key"}`, 200, "业务错误码 400"},
		{"http-error", `{"code":400,"message":"private-key"}`, 400, "HTTP 400"},
		{"invalid", `<html>private-key</html>`, 200, "无效响应"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/prefix/push" || r.URL.RawQuery != "" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
					t.Error("错误 Bark 请求", r.Method, r.URL)
				}
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["device_key"] != "private-key" || body["title"] != "更新通知" || body["body"] != "容器🚀已更新" || body["group"] != "DockerCopilot" {
					t.Error("JSON 参数不完整", body)
				}
				w.WriteHeader(test.status)
				w.Write([]byte(test.response))
			}))
			defer server.Close()
			err := SendBark(context.Background(), node.BarkSettings{ServerURL: server.URL + "/prefix/", DeviceKey: "private-key"}, Message{Title: "更新通知", Body: "容器🚀已更新"})
			if (err == nil) != (test.want == "") || err != nil && (!strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "private-key")) || calls.Load() != 1 {
				t.Fatal(err, calls.Load())
			}
		})
	}
}

func TestBarkDoesNotRedirectRetryOrUseProxy(t *testing.T) {
	var forwarded, calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Redirect(w, r, target.URL, 307) }))
	defer server.Close()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	err := SendBark(context.Background(), node.BarkSettings{ServerURL: server.URL, DeviceKey: "private-key"}, Message{})
	if err == nil || !strings.Contains(err.Error(), "HTTP 307") || calls.Load() != 1 || forwarded.Load() != 0 {
		t.Fatal(err, calls.Load(), forwarded.Load())
	}
}

func TestBarkTimeoutAndCertificateValidation(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(80 * time.Millisecond)
		w.Write([]byte(`{"code":200}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := SendBark(ctx, node.BarkSettings{ServerURL: server.URL, DeviceKey: "private-key"}, Message{})
	if err == nil || !strings.Contains(err.Error(), "超时") || calls.Load() != 1 {
		t.Fatal(err, calls.Load())
	}
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("使用了不受信任的证书") }))
	defer tls.Close()
	err = SendBark(context.Background(), node.BarkSettings{ServerURL: tls.URL, DeviceKey: "private-key"}, Message{})
	if err == nil || !strings.Contains(err.Error(), "证书") {
		t.Fatal(err)
	}
}
