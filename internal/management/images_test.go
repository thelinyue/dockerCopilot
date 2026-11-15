package management

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest"
)

func pruneTestAPI(t *testing.T, daemon http.HandlerFunc) (*Manager, string, string) {
	t.Helper()
	docker := httptest.NewServer(daemon)
	t.Cleanup(docker.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(docker.URL), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cli.Close() })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	cfg := config.Config{}
	cfg.Host, cfg.Port = "127.0.0.1", port
	cfg.Auth.AccessSecret = "image-prune-test-secret"
	m := New(&svc.ServiceContext{Config: cfg, DockerClient: cli})
	server := rest.MustNewServer(cfg.RestConf)
	m.Routes(server)
	t.Cleanup(server.Stop)
	go server.Start()
	address := fmt.Sprintf("http://127.0.0.1:%d", port)
	for deadline := time.Now().Add(3 * time.Second); ; {
		resp, err := http.Get(address + "/api/tasks")
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return m, address, signedTestToken(t, cfg.Auth.AccessSecret, time.Now().Add(time.Hour))
}

func pruneTestRequest(t *testing.T, address, token, device, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", address+"/api/image/prune", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if device != "" {
		req.Header.Set(node.DeviceHeader, device)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal("镜像清理接口未返回 JSON", resp.StatusCode, err)
	}
	return resp.StatusCode, result
}

func TestImagePruneUsesDaemonSafetyRules(t *testing.T) {
	for _, kind := range []string{"dangling", "unused"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			_, address, token := pruneTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1.47/images/prune" || r.URL.Query().Has("force") {
					t.Error("批量清理必须使用引擎清理接口，不能强制逐个删除", r.Method, r.URL.Path)
				}
				var filters map[string]map[string]bool
				if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters); err != nil {
					t.Error(err)
				}
				want := fmt.Sprint(kind == "dangling")
				if len(filters) != 1 || len(filters["dangling"]) != 1 || !filters["dangling"][want] {
					t.Error("清理范围不正确", filters)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"ImagesDeleted":[{"Untagged":"example/app:first"},{"Untagged":"example/app:second"},{"Deleted":"sha256:old"}],"SpaceReclaimed":4096}`)
			})
			status, result := pruneTestRequest(t, address, token, "", `{"type":"`+kind+`"}`)
			if status != 200 || calls.Load() != 1 {
				t.Fatal("多标签清理没有完成", status, result, calls.Load())
			}
			data, _ := result["data"].(map[string]any)
			if data["changed"] != true || data["spaceReclaimed"] != float64(4096) {
				t.Fatal("应返回实际释放空间，不按标签数报告删除镜像数", result)
			}
		})
	}
}

func TestImagePruneInvalidBusyAndFailure(t *testing.T) {
	var calls atomic.Int32
	m, address, token := pruneTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprint(w, `{"message":"a prune operation is already running"}`)
	})
	for _, body := range []string{`{}`, `{"type":"all"}`, `{"type":""}`, `invalid`} {
		status, _ := pruneTestRequest(t, address, token, "", body)
		if status != 400 {
			t.Fatal("无效清理范围应拒绝", status, body)
		}
	}
	m.Context.Operation.Lock()
	status, _ := pruneTestRequest(t, address, token, "", `{"type":"unused"}`)
	m.Context.Operation.Unlock()
	if status != 409 || calls.Load() != 0 {
		t.Fatal("节点已有变更时不能执行清理", status, calls.Load())
	}
	status, result := pruneTestRequest(t, address, token, "", `{"type":"unused"}`)
	if status != 400 || !strings.Contains(fmt.Sprint(result["msg"]), "镜像清理失败") || calls.Load() != 1 {
		t.Fatal("引擎冲突不得报告清理成功", status, result)
	}
}

func TestImagePruneStaysOnSelectedDevice(t *testing.T) {
	var localCalls, remoteCalls atomic.Int32
	m, address, token := pruneTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		localCalls.Add(1)
		w.WriteHeader(500)
	})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/auth" {
			if r.FormValue("secretKey") != "remote-test-key" {
				t.Error("远端凭据错误")
			}
			fmt.Fprint(w, `{"code":200,"data":{"jwt":"remote-test-token"}}`)
			return
		}
		remoteCalls.Add(1)
		if r.URL.Path != "/api/image/prune" || r.Method != "POST" || r.Header.Get(node.DeviceHeader) != "" || r.Header.Get("Authorization") != "Bearer remote-test-token" {
			t.Error("清理请求的设备归属或认证头错误")
		}
		var body struct{ Type string }
		json.NewDecoder(r.Body).Decode(&body)
		if body.Type != "unused" {
			t.Error("远端清理范围丢失")
		}
		fmt.Fprint(w, `{"code":200,"data":{"changed":true,"spaceReclaimed":8192}}`)
	}))
	defer remote.Close()
	devices, err := node.OpenDevices(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m.Context.Devices = devices
	device, err := devices.Save(node.Device{Name: "test", Address: remote.URL, Secret: "remote-test-key"})
	if err != nil {
		t.Fatal(err)
	}
	status, result := pruneTestRequest(t, address, token, device.ID, `{"type":"unused"}`)
	if status != 200 || localCalls.Load() != 0 || remoteCalls.Load() != 1 {
		t.Fatal("远端清理影响了本机或被重复提交", status, result, localCalls.Load(), remoteCalls.Load())
	}
}
