package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func TestAutomaticUpdateUsesSavedRetentionSnapshot(t *testing.T) {
	for _, keep := range []bool{false, true} {
		t.Run(map[bool]string{false: "删除", true: "保留"}[keep], func(t *testing.T) {
			settings, err := node.OpenSettings(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			patch, _ := json.Marshal(map[string]bool{"keepOldContainer": keep})
			if err := settings.Patch(patch); err != nil {
				t.Fatal(err)
			}
			t.Setenv("DelOldContainer", map[bool]string{false: "false", true: "true"}[keep])
			original := docker.ContainerJSON{
				ContainerJSONBase: &docker.ContainerJSONBase{ID: "original", Name: "/app", Image: "sha256:old", HostConfig: &container.HostConfig{}, State: &docker.ContainerState{Running: true, Health: &docker.Health{Status: "healthy"}}},
				Config:            &container.Config{Image: "example/app:latest"},
			}
			var removed atomic.Bool
			daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == "DELETE" && strings.HasSuffix(r.URL.Path, "/containers/original"):
					removed.Store(true)
					w.WriteHeader(http.StatusNoContent)
				case strings.HasSuffix(r.URL.Path, "/containers/json"):
					w.Write([]byte("[]"))
				case r.Method == "GET" && strings.Contains(r.URL.Path, "/images/"):
					json.NewEncoder(w).Encode(docker.ImageInspect{RepoTags: []string{"example/app:old"}})
				case r.Method == "GET":
					json.NewEncoder(w).Encode(original)
				case strings.HasSuffix(r.URL.Path, "/images/create"):
					opposite, _ := json.Marshal(map[string]bool{"keepOldContainer": !keep})
					if err := settings.Patch(opposite); err != nil {
						t.Error(err)
					}
					w.Write([]byte("{\"status\":\"complete\"}\n"))
				case strings.HasSuffix(r.URL.Path, "/containers/create"):
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(container.CreateResponse{ID: "replacement"})
				default:
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			defer daemon.Close()
			cli, err := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
			if err != nil {
				t.Fatal(err)
			}
			defer cli.Close()
			s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
			s.UpdateProgress("retention-task", svc.TaskProgress{Name: "保留策略验证"})
			run := newCheckRun()
			run.containers[original.ID] = original
			run.images[original.Config.Image+"\n"+original.Image] = module.ImageCheckList{NeedUpdate: true}
			if _, err := New(s).autoUpdateContainer(context.Background(), "retention-task", original.ID, run); err != nil {
				t.Fatal(err)
			}
			if removed.Load() == keep {
				t.Fatal("自动更新未遵循开始时保存的策略", keep, removed.Load())
			}
		})
	}
}

func TestRuntimeSettingsAPIIsAuthenticatedAndRedactsGithubCredentials(t *testing.T) {
	m, request, _ := notificationAPI(t)
	body := `{"keepOldContainer":true,"githubProxy":"https://user:fixture-credential@mirror.example/prefix"}`
	if w := request("PUT", "/api/settings", body, false); w.Code != http.StatusUnauthorized {
		t.Fatal("未登录可修改更新设置", w.Code)
	}
	if w := request("PUT", "/api/settings", body, true); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	w := request("GET", "/api/settings", "", true)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "fixture-credential") || !strings.Contains(w.Body.String(), `"keepOldContainer":true`) {
		t.Fatal("运行设置读取泄漏凭据或丢失保留策略", w.Body.String())
	}
	if got := m.Context.Settings.Get(); got.GithubProxy == node.RedactProxy(got.GithubProxy) {
		t.Fatal("脱敏修改了内部真实凭据")
	}
}
