package container

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	docker "github.com/docker/docker/api/types"
	dockercontainer "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
)

func TestManualUpdateUsesSavedRetentionAndHonorsLegacyKeepRequest(t *testing.T) {
	for _, tc := range []struct {
		name, request string
		keep, remove  bool
	}{
		{"默认删除", "", false, true},
		{"设备保留优先", "true", true, false},
		{"兼容单次保留", "false", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			settings, err := node.OpenSettings(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			patch, _ := json.Marshal(map[string]bool{"keepOldContainer": tc.keep})
			if err := settings.Patch(patch); err != nil {
				t.Fatal(err)
			}
			// 与已保存策略相反的环境变量不得重新介入更新决策。
			t.Setenv("DelOldContainer", map[bool]string{false: "false", true: "true"}[tc.keep])
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
					id := "original"
					if strings.Contains(r.URL.Path, "replacement") {
						id = "replacement"
					}
					json.NewEncoder(w).Encode(docker.ContainerJSON{
						ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/app", Image: "sha256:old", HostConfig: &dockercontainer.HostConfig{}, State: &docker.ContainerState{Running: true, Health: &docker.Health{Status: "healthy"}}},
						Config:            &dockercontainer.Config{Image: "example/app:latest"},
					})
				case strings.HasSuffix(r.URL.Path, "/images/create"):
					// 在途保存不能改变本次更新开始时选定的清理策略。
					opposite, _ := json.Marshal(map[string]bool{"keepOldContainer": !tc.keep})
					if err := settings.Patch(opposite); err != nil {
						t.Error(err)
					}
					w.Write([]byte("{\"status\":\"complete\"}\n"))
				case strings.HasSuffix(r.URL.Path, "/containers/create"):
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(dockercontainer.CreateResponse{ID: "replacement"})
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
			response, err := NewUpdateLogic(context.Background(), s).Update(&types.ContainerUpdateReq{IdReq: types.IdReq{Id: "original"}, DelOldContainer: tc.request})
			if err != nil {
				t.Fatal(err)
			}
			id := response.Data.(map[string]string)["taskID"]
			for deadline := time.Now().Add(3 * time.Second); ; {
				progress, _ := s.GetProgress(id)
				if progress.IsDone {
					if progress.Status != "succeeded" || removed.Load() != tc.remove {
						t.Fatal("手动更新未遵循保留策略", progress, removed.Load())
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("手动更新未完成", progress)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
