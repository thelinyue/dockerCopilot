package handler

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/management"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest"
)

func TestProgressRouteRequiresJWT(t *testing.T) {
	port := getFreePort(t)
	cfg := config.Config{}
	cfg.Host = "127.0.0.1"
	cfg.Port = port
	cfg.Auth.AccessSecret = "test-secret"

	server := rest.MustNewServer(cfg.RestConf)
	s := &svc.ServiceContext{Config: cfg}
	RegisterHandlers(server, s, management.New(s))
	defer server.Stop()

	go server.Start()
	waitForServer(t, port)

	for _, route := range []struct{ method, path string }{
		{"GET", "/progress/test-task"}, {"GET", "/node/info"}, {"GET", "/settings"}, {"PUT", "/settings"},
		{"GET", "/tasks"}, {"POST", "/checks"}, {"POST", "/auto-update"},
		{"POST", "/image/prune"},
		{"GET", "/compose/projects"}, {"POST", "/compose/projects"}, {"GET", "/compose/projects/test/files/0"}, {"PUT", "/compose/projects/test/files/0"}, {"POST", "/compose/projects/test/actions"},
		{"POST", "/compose/projects/test/files/0/validate"},
		{"GET", "/devices"}, {"POST", "/devices"}, {"PUT", "/devices/test"}, {"DELETE", "/devices/test"}, {"POST", "/devices/test/test"}, {"GET", "/icon-file?name=test.png"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			req, _ := http.NewRequest(route.method, fmt.Sprintf("http://127.0.0.1:%d/api%s", port, route.path), nil)
			req.Header.Set("X-DockerCopilot-Device-ID", "untrusted")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("expected JWT 401, got %d", resp.StatusCode)
			}
		})
	}
}

func TestAuthRouteDoesNotRequireJWT(t *testing.T) {
	port := getFreePort(t)
	cfg := config.Config{}
	cfg.Host = "127.0.0.1"
	cfg.Port = port
	cfg.Auth.AccessSecret = "test-secret"

	server := rest.MustNewServer(cfg.RestConf)
	s := &svc.ServiceContext{Config: cfg}
	RegisterHandlers(server, s, management.New(s))
	defer server.Stop()

	go server.Start()
	waitForServer(t, port)

	req, err := http.NewRequest(
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/api/auth", port),
		bytes.NewBufferString("secretKey=test-secret"),
	)
	if err != nil {
		t.Fatalf("failed to create auth request: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to call auth route: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read auth response body: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from auth route without JWT, got %d with body %s", resp.StatusCode, string(body))
	}
}

// 移除备份后，旧接口既不能在本机调用，也不能经主节点继续转发到旧版本设备。
func TestRemovedBackupRoutesAreUnavailable(t *testing.T) {
	var forwarded atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer remote.Close()
	devices, err := node.OpenDevices(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	device, err := devices.Save(node.Device{Name: "旧版本设备", Address: remote.URL, Secret: "remote-test-secret"})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{}
	cfg.Host = "127.0.0.1"
	cfg.Port = getFreePort(t)
	cfg.Auth.AccessSecret = "test-secret"
	server := rest.MustNewServer(cfg.RestConf)
	s := &svc.ServiceContext{Config: cfg, Devices: devices}
	RegisterHandlers(server, s, management.New(s))
	defer server.Stop()
	go server.Start()
	waitForServer(t, cfg.Port)
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte(cfg.Auth.AccessSecret))
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct{ method, path string }{
		{"GET", "/container/backup"}, {"GET", "/container/backup2compose"},
		{"GET", "/container/listBackups"}, {"DELETE", "/container/backups?filename=backup.json"},
		{"POST", "/container/backups/restore"},
	} {
		for _, deviceID := range []string{"local", device.ID} {
			t.Run(route.method+route.path+"/"+deviceID, func(t *testing.T) {
				req, _ := http.NewRequest(route.method, fmt.Sprintf("http://127.0.0.1:%d/api%s", cfg.Port, route.path), nil)
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set(node.DeviceHeader, deviceID)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				if resp.StatusCode != http.StatusNotFound {
					t.Fatalf("已移除的接口应返回 404，实际为 %d", resp.StatusCode)
				}
			})
		}
	}
	if forwarded.Load() != 0 {
		t.Fatal("已移除的备份接口仍然向远端发送了请求")
	}
}

func getFreePort(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to get free port: %v", err)
	}
	defer listener.Close()

	return listener.Addr().(*net.TCPAddr).Port
}

func waitForServer(t *testing.T, port int) {
	t.Helper()

	client := &http.Client{Timeout: 200 * time.Millisecond}
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Fatalf("server on port %d did not become ready", port)
}
