package management

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest"
)

func TestSchedulesRegisterOneJobAndPreserveUpdateTime(t *testing.T) {
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := settings.Get()
	s.CheckCron, s.UpdateCron, s.AutoUpdate = "30 * * * *", "0 3 * * *", true
	if err := settings.Save(s); err != nil {
		t.Fatal(err)
	}
	m := New(&svc.ServiceContext{Settings: settings})
	m.ReloadSchedules()
	if entries := m.cron.Entries(); len(entries) != 1 {
		t.Fatal("检测和自动更新仍注册了两个任务", len(entries))
	}
	m.cron.Start()
	defer m.Stop()
	next := m.NextRuns()
	if next["schedule"] == nil || next["schedule"] != next["check"] || next["schedule"] != next["update"] {
		t.Fatal("统一计划没有返回一致的下次执行时间", next)
	}
	if scheduled := next["schedule"].(time.Time); scheduled.Hour() != 3 || scheduled.Minute() != 0 {
		t.Fatal("原每天 03:00 的更新被改成了其他频率", scheduled)
	}
	s = settings.Get()
	s.AutoUpdate = false
	if err := settings.Save(s); err != nil {
		t.Fatal(err)
	}
	m.ReloadSchedules()
	if len(m.cron.Entries()) != 1 {
		t.Fatal("保存后残留旧任务")
	}
	if !m.NextRuns()["update"].(time.Time).IsZero() {
		t.Fatal("只检测时仍显示独立更新时间")
	}
}

func TestAutomationHTTPRequestsShareTaskScopeAndPreserveSettingsOnFailure(t *testing.T) {
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{Settings: settings, HubImageInfo: module.NewImageCheck()}
	s.Config.Auth.AccessSecret = "unified-schedule-test-secret"
	m := New(s)
	server := rest.MustNewServer(config.Config{}.RestConf)
	defer server.Stop()
	m.Routes(server)
	handlers := map[string]http.HandlerFunc{}
	for _, route := range server.Routes() {
		handlers[route.Method+" "+route.Path] = route.Handler
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+signedTestToken(t, s.Config.Auth.AccessSecret, time.Now().Add(time.Hour)))
		w := httptest.NewRecorder()
		handler, ok := handlers[method+" "+path]
		if !ok {
			t.Fatal("缺少接口", method, path)
		}
		handler(w, r)
		return w
	}
	release, err := s.Acquire(svc.OperationScope{Job: "automation"})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, path := range []string{"/api/checks", "/api/auto-update"} {
		if w := request("POST", path, ""); w.Code != http.StatusConflict {
			t.Fatal("检测和更新没有互斥", path, w.Code, w.Body.String())
		}
	}
	if len(s.Tasks()) != 0 {
		t.Fatal("冲突请求仍创建了任务")
	}
	before := settings.Get()
	if w := request("PUT", "/api/settings", `{"checkCron":"invalid","updateCron":"0 3 * * *"}`); w.Code != http.StatusBadRequest || settings.Get().CheckCron != before.CheckCron {
		t.Fatal("无效计划保存后改变了配置", w.Code, w.Body.String())
	}
	if w := request("PUT", "/api/settings", `{"checkCron":"15 2 * * *","updateCron":"15 2 * * *","autoUpdate":true}`); w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	w := request("GET", "/api/settings", "")
	var result struct {
		Data struct {
			Settings node.Settings  `json:"settings"`
			NextRuns map[string]any `json:"nextRuns"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Data.Settings.CheckCron != "15 2 * * *" || result.Data.Settings.UpdateCron != "15 2 * * *" || result.Data.NextRuns["schedule"] == nil {
		t.Fatal("统一计划接口未保存或返回正确语义", w.Body.String(), err)
	}
}

func TestSettingsSaveRetainsDetectionAndSchedule(t *testing.T) {
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{Settings: settings, HubImageInfo: module.NewImageCheck()}
	s.Config.Auth.AccessSecret = "notification-settings-test"
	m := New(s)
	m.ReloadSchedules()
	m.cron.Start()
	defer m.Stop()
	server := rest.MustNewServer(config.Config{}.RestConf)
	defer server.Stop()
	m.Routes(server)
	var save http.HandlerFunc
	for _, route := range server.Routes() {
		if route.Method == "PUT" && route.Path == "/api/settings" {
			save = route.Handler
		}
	}
	s.HubImageInfo.Set("app", module.ImageCheckList{NeedUpdate: true, CheckedAt: time.Now()})
	entry, next := m.scheduleJob, m.NextRuns()["schedule"]
	for _, body := range []string{`{}`, `{"startupCheck":false}`, `{"httpsProxy":"http://proxy.example:7890"}`, `{"excludedContainers":["app"]}`, `{"autoUpdate":true}`} {
		r := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+signedTestToken(t, s.Config.Auth.AccessSecret, time.Now().Add(time.Hour)))
		w := httptest.NewRecorder()
		save(w, r)
		if w.Code != http.StatusOK {
			t.Fatal(body, w.Code, w.Body.String())
		}
		if result, ok := s.HubImageInfo.Get("app"); !ok || !result.NeedUpdate {
			t.Fatal("保存无关设置清除了上次检测结果", body)
		}
		if m.scheduleJob != entry || m.NextRuns()["schedule"] != next {
			t.Fatal("执行频率未变化却重建了计划", body)
		}
	}
}

func TestScheduleReadsLatestModeWithoutReplacingJob(t *testing.T) {
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/containers/json") {
			t.Error("空设备计划执行了意外操作", r.Method, r.URL.Path)
		}
		w.Write([]byte("[]"))
	}))
	defer daemon.Close()
	cli, err := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{Settings: settings, DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	m.ReloadSchedules()
	m.cron.Start()
	defer m.Stop()
	entry, next := m.scheduleJob, m.NextRuns()["schedule"]
	for i, mode := range []bool{false, true} {
		patch, _ := json.Marshal(map[string]bool{"autoUpdate": mode})
		if err := settings.Patch(patch); err != nil {
			t.Fatal(err)
		}
		m.ReloadSchedules()
		if m.scheduleJob != entry || m.NextRuns()["schedule"] != next {
			t.Fatal("切换模式重置了计划")
		}
		m.cron.Entry(entry).Job.Run()
		for deadline := time.Now().Add(2 * time.Second); ; {
			tasks := s.Tasks()
			if len(tasks) == i+1 && tasks[0].IsDone {
				want := "check"
				if mode {
					want = "auto-update"
				}
				if tasks[0].Action != want || tasks[0].Status != "succeeded" {
					t.Fatal("调度使用了旧模式", tasks)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("计划任务未完成", tasks)
			}
			time.Sleep(time.Millisecond)
		}
	}
}

func TestStartupOnlyChecksAndScheduledJobsShareManualTaskScope(t *testing.T) {
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/containers/json") {
			t.Error("启动检测触发了更新操作", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		w.Write([]byte("[]"))
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(t.TempDir())
	v := settings.Get()
	v.AutoUpdate = true
	if err := settings.Save(v); err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{Settings: settings, DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	m.Start()
	defer m.Stop()
	for deadline := time.Now().Add(2 * time.Second); ; {
		tasks := s.Tasks()
		if len(tasks) == 1 && tasks[0].IsDone {
			if tasks[0].Action != "check" || tasks[0].Name != "启动检测" || tasks[0].Status != "succeeded" {
				t.Fatal("开启自动更新后启动检测也执行了更新", tasks)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("启动检测未完成", tasks)
		}
		time.Sleep(10 * time.Millisecond)
	}
	release, err := s.Acquire(svc.OperationScope{Job: "automation"})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	m.launch("定时检测", "check", m.Check)
	m.cron.Entries()[0].Job.Run()
	if len(s.Tasks()) != 1 {
		t.Fatal("已有任务时定时检测或更新仍重复启动")
	}
}
