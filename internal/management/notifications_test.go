package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest"
)

func TestObjectReadFailuresRemainInNotifications(t *testing.T) {
	labels := map[string]string{projectLabel: "app", serviceLabel: "web"}
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/containers/json") {
			json.NewEncoder(w).Encode([]docker.Container{{ID: "replica-a", Names: []string{"/app-web-1"}, Image: "example/web:latest", Labels: labels}, {ID: "replica-b", Names: []string{"/app-web-2"}, Image: "example/web:latest", Labels: labels}})
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"message":"private-daemon-error"}`))
	}))
	defer daemon.Close()
	cli, err := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	s := &svc.ServiceContext{DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	if err := m.Check(context.Background(), "check-read-failure"); err == nil {
		t.Fatal("读取失败却返回检查成功")
	}
	p, _ := s.GetProgress("check-read-failure")
	settings := node.DefaultNotifications()
	settings.Enabled = true
	message, send := notify.Format(settings, "NAS", time.Now(), p.NoticeResults)
	if !send || strings.Count(message.Body, "app/web") != 1 || !strings.Contains(message.Body, "2 副本") || strings.Contains(message.Body, "private-daemon-error") {
		t.Fatal("无法读取的项目副本未合并或包含原始错误", message)
	}
	if _, err := m.autoUpdateContainer(context.Background(), "update-read-failure", "unreadable", newCheckRun()); err == nil {
		t.Fatal("更新前读取失败却返回成功")
	}
	p, _ = s.GetProgress("update-read-failure")
	if len(p.NoticeResults) != 1 || p.NoticeResults[0].Object != "unreadable" || p.NoticeResults[0].Kind != notify.CheckFailed {
		t.Fatal("更新前读取失败缺少对象结果", p.NoticeResults)
	}
}

func notificationAPI(t *testing.T) (*Manager, func(string, string, string, bool) *httptest.ResponseRecorder, string) {
	t.Helper()
	dir := t.TempDir()
	settings, err := node.OpenSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{Settings: settings, HubImageInfo: module.NewImageCheck()}
	s.Config.Auth.AccessSecret = "notification-http-test"
	m := New(s)
	m.ReloadSchedules()
	server := rest.MustNewServer(config.Config{}.RestConf)
	t.Cleanup(server.Stop)
	m.Routes(server)
	handlers := map[string]http.HandlerFunc{}
	for _, route := range server.Routes() {
		handlers[route.Method+" "+route.Path] = route.Handler
	}
	return m, func(method, path, body string, authorized bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if authorized {
			r.Header.Set("Authorization", "Bearer "+signedTestToken(t, s.Config.Auth.AccessSecret, time.Now().Add(time.Hour)))
		}
		w := httptest.NewRecorder()
		handlers[method+" "+path](w, r)
		return w
	}, filepath.Join(dir, "settings.json")
}

func TestBarkTestAPIUsesDraftWithoutSavingAndRedactsKey(t *testing.T) {
	m, request, path := notificationAPI(t)
	var calls atomic.Int32
	bark := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/custom/push" || body["device_key"] != "stored-private-key" {
			t.Error("草稿地址或保留的密钥不正确", r.URL)
		}
		w.Write([]byte(`{"code":200}`))
	}))
	defer bark.Close()
	if w := request("PUT", "/api/settings", `{"notifications":{"bark":{"deviceKey":"stored-private-key"}}}`, true); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := request("GET", "/api/settings", "", true)
	if strings.Contains(w.Body.String(), "stored-private-key") || strings.Contains(w.Body.String(), "deviceKey") || !strings.Contains(w.Body.String(), `"hasKey":true`) {
		t.Fatal("读取泄漏密钥", w.Body.String())
	}
	before, _ := os.ReadFile(path)
	body, _ := json.Marshal(node.BarkSettings{ServerURL: bark.URL + "/custom", DeviceKey: ""})
	if w := request("POST", "/api/notifications/test", string(body), false); w.Code != 401 {
		t.Fatal("未登录可发送通知")
	}
	w = request("POST", "/api/notifications/test", string(body), true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Bark 已接受推送") || calls.Load() != 1 {
		t.Fatal(w.Code, w.Body.String(), calls.Load())
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) || len(m.Context.Tasks()) != 0 || m.Context.Settings.Get().Notifications.Enabled {
		t.Fatal("测试修改配置或创建了操作任务")
	}
}

func TestBarkWSLServerIntegration(t *testing.T) {
	address := os.Getenv("DOCKERCOPILOT_BARK_TEST_URL")
	if address == "" {
		t.Skip("设置 DOCKERCOPILOT_BARK_TEST_URL 后验证独立 Bark 服务端")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(strings.TrimRight(address, "/") + "/ping")
	if err != nil {
		t.Fatal(err)
	}
	var ping struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	json.NewDecoder(resp.Body).Decode(&ping)
	resp.Body.Close()
	if resp.StatusCode != 200 || ping.Code != 200 || ping.Message != "pong" {
		t.Fatal("Bark 健康检查未通过", resp.StatusCode, ping)
	}
	m, request, _ := notificationAPI(t)
	body, _ := json.Marshal(node.BarkSettings{ServerURL: address, DeviceKey: "dockercopilot-unregistered-integration-key"})
	w := request("POST", "/api/notifications/test", string(body), true)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "HTTP 400") || strings.Contains(w.Body.String(), "unregistered-integration-key") {
		t.Fatal("实际 Bark 错误未正确处理", w.Code, w.Body.String())
	}
	v := m.Context.Settings.Get()
	v.Notifications.Enabled = true
	v.Notifications.Bark = node.BarkSettings{ServerURL: address, DeviceKey: "dockercopilot-unregistered-integration-key"}
	if err := m.Context.Settings.Save(v); err != nil {
		t.Fatal(err)
	}
	id, err := m.Context.RunTask("Bark 联调任务", svc.OperationScope{Job: "notification-test"}, "check", func(id string) error {
		m.Context.RecordNotice(id, notify.Result{Key: "fixture", Object: "联调样例", Image: "example/app:latest", Kind: notify.Available})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(4 * time.Second); ; {
		p, _ := m.Context.GetProgress(id)
		if p.Notification != nil && p.Notification.Status != "sending" {
			if p.Status != "succeeded" || p.Notification.Status != "failed" || !strings.Contains(p.Notification.Message, "HTTP 400") {
				t.Fatal("实际服务端推送失败改变了任务结果", p)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("实际 Bark 任务通知超时", p)
		}
		time.Sleep(time.Millisecond)
	}
	t.Log("官方 Bark /ping 返回 200；测试接口及任务结束入口通过路径前缀调用 /push，正确报告未注册设备的 HTTP 400，业务任务保持成功")
}
