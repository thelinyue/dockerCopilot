package svc

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
)

func waitNotification(t *testing.T, s *ServiceContext, id string) TaskProgress {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); ; {
		p, _ := s.GetProgress(id)
		if p.IsDone && p.Notification != nil && p.Notification.Status != "sending" {
			return p
		}
		if time.Now().After(deadline) {
			t.Fatal("通知未结束", p)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestTaskNotificationOnceAfterReleaseAndAggregatesOutcomes(t *testing.T) {
	s := &ServiceContext{}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		p := s.Tasks()[0]
		if !p.IsDone || p.Status != "failed" {
			t.Error("通知在任务最终状态前发送", p)
		}
		release, err := s.Acquire(OperationScope{Job: "automation"})
		if err != nil {
			t.Error("通知仍持有任务锁", err)
		} else {
			release()
		}
		var body notify.Message
		json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(body.Body, "已恢复") || !strings.Contains(body.Body, "app-success") || strings.Count(body.Body, "app-success") != 1 || strings.Contains(body.Body, "private-input") {
			t.Error("汇总丢失对象结果或泄漏原始错误", body)
		}
		w.Write([]byte(`{"code":200}`))
	}))
	defer server.Close()
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v := settings.Get()
	v.Notifications.Enabled = true
	v.Notifications.Bark = node.BarkSettings{ServerURL: server.URL, DeviceKey: "test-key"}
	if err := settings.Save(v); err != nil {
		t.Fatal(err)
	}
	s.Settings = settings
	id, err := s.RunTask("检测并更新", OperationScope{Job: "automation"}, "auto-update", func(id string) error {
		s.RecordNotice(id, notify.Result{Key: "service:app/web", ID: "replica-a", Object: "app/web", Image: "app:latest", Kind: notify.Available})
		s.RecordNotice(id, notify.Result{Key: "service:app/web", ID: "replica-b", Object: "app/web", Image: "app:latest", Kind: notify.Available})
		s.RecordNotice(id, notify.Result{Key: "service:app/web", Object: "app/web", Image: "app:latest", Kind: notify.UpdateFailed, Outcome: "rolled_back", Replicas: 2})
		s.RecordNotice(id, notify.Result{Key: "container:app-success", Object: "app-success", Image: "app:latest", Kind: notify.Available})
		s.RecordNotice(id, notify.Result{Key: "container:app-success", Object: "app-success", Image: "app:latest", Kind: notify.UpdateSucceeded})
		return errors.New("private-input")
	})
	if err != nil {
		t.Fatal(err)
	}
	p := waitNotification(t, s, id)
	if p.Status != "failed" || p.Notification.Status != "sent" || calls.Load() != 1 {
		t.Fatal(p, calls.Load())
	}
}

func TestNotificationFailureKeepsTaskResultAndPanicReportsOnce(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(400)
		w.Write([]byte(`{"code":400}`))
	}))
	defer server.Close()
	settings, _ := node.OpenSettings(t.TempDir())
	v := settings.Get()
	v.Notifications.Enabled = true
	v.Notifications.Bark = node.BarkSettings{ServerURL: server.URL, DeviceKey: "test-key"}
	if err := settings.Save(v); err != nil {
		t.Fatal(err)
	}
	s := &ServiceContext{Settings: settings}
	id, err := s.RunTask("手动更新", OperationScope{Job: "test"}, "update", func(id string) error {
		s.RecordNotice(id, notify.Result{Key: "app", Object: "app", Kind: notify.UpdateSucceeded})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	p := waitNotification(t, s, id)
	if p.Status != "succeeded" || p.Percentage != 100 || p.Notification.Status != "failed" || !strings.Contains(p.Notification.Message, "HTTP 400") {
		t.Fatal(p)
	}
	id, err = s.RunTask("检测异常", OperationScope{Job: "test"}, "check", func(string) error { panic("private-input") })
	if err != nil {
		t.Fatal(err)
	}
	p = waitNotification(t, s, id)
	if p.Status != "failed" || calls.Load() != 2 || strings.Contains(p.Message, "private-input") {
		t.Fatal(p, calls.Load())
	}
}

func TestReportsForLatestAndDisabledEventsStayQuiet(t *testing.T) {
	settings, _ := node.OpenSettings(t.TempDir())
	v := settings.Get()
	v.Notifications.Enabled = true
	v.Notifications.Bark.DeviceKey = "test-key"
	v.Notifications.UpdateSucceeded = false
	if err := settings.Save(v); err != nil {
		t.Fatal(err)
	}
	s := &ServiceContext{Settings: settings}
	s.UpdateProgress("latest", TaskProgress{Name: "检查", IsDone: true, Status: "succeeded"})
	s.finishNotification("latest", "check")
	s.RecordNotice("updated", notify.Result{Key: "app", Object: "app", Kind: notify.Available})
	s.RecordNotice("updated", notify.Result{Key: "app", Object: "app", Kind: notify.UpdateSucceeded})
	s.UpdateProgress("updated", TaskProgress{Name: "检测并更新", IsDone: true, Status: "succeeded"})
	s.finishNotification("updated", "auto-update")
	for _, id := range []string{"latest", "updated"} {
		if p, _ := s.GetProgress(id); p.Notification != nil {
			t.Fatal("无匹配内容却发送", p)
		}
	}
}
