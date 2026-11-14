package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zeromicro/go-zero/rest"
	"github.com/zeromicro/go-zero/rest/router"
)

// PWA 使用根路径注册，必须覆盖生产嵌入资源，不能仅在 Vite 开发服务器验证。
func TestPWARootAssets(t *testing.T) {
	server := rest.MustNewServer(rest.RestConf{})
	RegisterHandlers(server)
	routes := router.NewRouter()
	for _, route := range server.Routes() {
		if err := routes.Handle(route.Method, route.Path, route.Handler); err != nil {
			t.Fatal(err)
		}
	}
	if err := routes.Handle(http.MethodGet, "/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/manager", http.StatusMovedPermanently)
	})); err != nil {
		t.Fatal(err)
	}
	fixture := httptest.NewServer(routes)
	defer fixture.Close()

	for _, asset := range []struct{ path, contentType string }{
		{"/manifest.json", "json"}, {"/sw.js", "javascript"}, {"/logo.png", "image/png"}, {"/index.html", "text/html"},
	} {
		t.Run(asset.path, func(t *testing.T) {
			response, err := fixture.Client().Get(fixture.URL + asset.path)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), asset.contentType) {
				t.Fatalf("PWA 资源不可用：状态 %d，类型 %s", response.StatusCode, response.Header.Get("Content-Type"))
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := embeddedFront.ReadFile("front" + asset.path)
			if err != nil || !bytes.Equal(body, expected) {
				t.Fatalf("PWA 资源未返回完整嵌入文件：%v", err)
			}
		})
	}
}
