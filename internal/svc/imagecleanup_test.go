package svc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
)

func TestOldImageCleanupIsScopedAndNonDestructive(t *testing.T) {
	var mu sync.Mutex
	removed := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/containers/json") {
			json.NewEncoder(w).Encode([]docker.Container{{ImageID: "running", State: "running"}, {ImageID: "stopped", State: "exited"}})
		} else if r.Method == "GET" {
			v := docker.ImageInspect{}
			if strings.Contains(r.URL.Path, "tagged") {
				v.RepoTags = []string{"example/app:old"}
			}
			json.NewEncoder(w).Encode(v)
		} else if r.Method == "DELETE" {
			if r.URL.Query().Get("force") == "1" || r.URL.Query().Get("noprune") != "1" {
				t.Error("自动清理使用了强制删除或递归删除父镜像", r.URL.RawQuery)
			}
			mu.Lock()
			removed = append(removed, r.URL.Path)
			mu.Unlock()
			w.Write([]byte(`[{"Deleted":"unused"}]`))
		} else {
			t.Error("自动清理访问了范围外的接口", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	defer cli.Close()
	s := &ServiceContext{DockerClient: cli}
	s.UpdateProgress("task", TaskProgress{Name: "update", Status: "succeeded", IsDone: true})
	s.ScheduleImageCleanup("task", "unused", "unused", "running", "stopped", "tagged")
	s.CleanupTaskImages("task")
	mu.Lock()
	defer mu.Unlock()
	if len(removed) != 1 || !strings.HasSuffix(removed[0], "/images/unused") {
		t.Fatal("删除了本次范围外或受保护的镜像", removed)
	}
	p, _ := s.GetProgress("task")
	if p.Status != "succeeded" || !strings.Contains(p.Cleanup, "删除 1 个，保留 3 个") {
		t.Fatal(p)
	}
}

func TestCleanupFailureDoesNotFailSuccessfulUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer server.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	defer cli.Close()
	s := &ServiceContext{DockerClient: cli}
	id, err := s.RunTask("更新", ProjectScope("app", "/app"), "update", func(id string) error { s.ScheduleImageCleanup(id, "old"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(time.Second); ; {
		p, _ := s.GetProgress(id)
		if p.IsDone {
			if p.Status != "succeeded" || !strings.Contains(p.Message, "清理未完成") {
				t.Fatal(p)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("任务未完成")
		}
		time.Sleep(time.Millisecond)
	}
}
