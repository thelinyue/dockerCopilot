package module

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

func TestPlatformManifestAndAuthenticationUseProxy(t *testing.T) {
	const old = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const current = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var tokens, manifests, tunnels atomic.Int32
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/Token" {
			tokens.Add(1)
			if r.URL.Query().Get("service") != "CaseSensitive" || r.URL.Query().Get("scope") != "repository:team/app:pull" {
				t.Error("auth values changed case", r.URL.String())
			}
			io.WriteString(w, `{"token":"SecretToken"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer SecretToken" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="https://auth.example.com/Token",service="CaseSensitive"`)
			w.WriteHeader(401)
			return
		}
		manifests.Add(1)
		switch r.URL.Path {
		case "/v2/team/app/manifests/Stable":
			io.WriteString(w, `{"manifests":[{"digest":"sha256:arm","platform":{"os":"linux","architecture":"arm64","variant":"v8"}},{"digest":"sha256:v3","platform":{"os":"linux","architecture":"amd64","variant":"v3"}},{"digest":"sha256:amd","platform":{"os":"linux","architecture":"amd64"}}]}`)
		case "/v2/team/app/manifests/sha256:amd":
			fmt.Fprintf(w, `{"config":{"digest":%q}}`, current)
		default:
			t.Error("unexpected layer or platform request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer registry.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Error("expected HTTPS tunnel")
			w.WriteHeader(500)
			return
		}
		tunnels.Add(1)
		upstream, err := net.Dial("tcp", registry.Listener.Addr().String())
		if err != nil {
			t.Error(err)
			return
		}
		defer upstream.Close()
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go io.Copy(upstream, connection)
		io.Copy(connection, upstream)
	}))
	defer proxy.Close()
	client := ProxyClient(node.Settings{HTTPSProxy: proxy.URL})
	transport := client.Transport.(*http.Transport)
	transport.TLSClientConfig = registry.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	defer client.CloseIdleConnections()
	update, err := CheckReference(context.Background(), client, "registry.example.com:5443/team/app:Stable", old, "linux", "amd64", "")
	if err != nil || !update {
		t.Fatal(update, err)
	}
	update, err = CheckReference(context.Background(), client, "registry.example.com:5443/team/app:Stable", current, "linux", "amd64", "")
	if err != nil || update {
		t.Fatal(update, err)
	}
	if tokens.Load() != 2 || manifests.Load() != 4 || tunnels.Load() < 2 {
		t.Fatal("proxy/auth/platform coverage missing", tokens.Load(), manifests.Load(), tunnels.Load())
	}
	_, err = CheckReference(context.Background(), client, "registry.example.com/team/app:Stable", current, "windows", "amd64", "")
	if err == nil {
		t.Fatal("missing platform reported as latest")
	}
}

func TestRegistryTLSValidationAndPinnedReference(t *testing.T) {
	client := ProxyClient(node.Settings{})
	if transport := client.Transport.(*http.Transport); transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{}`) }))
	defer server.Close()
	_, err := CheckReference(context.Background(), client, strings.TrimPrefix(server.URL, "https://")+"/app:latest", "sha256:test", "linux", "amd64", "")
	if err == nil {
		t.Fatal("untrusted TLS certificate accepted")
	}
	update, err := CheckReference(context.Background(), client, "example.com/app@sha256:"+strings.Repeat("a", 64), "sha256:x", "linux", "amd64", "")
	if err != nil || update {
		t.Fatal("immutable reference must not make network request", err)
	}
}
