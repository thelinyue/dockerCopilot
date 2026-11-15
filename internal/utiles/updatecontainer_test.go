package utiles

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func TestUpdateKeepsOtherContainersCheckResults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/json"):
			id := "old-container"
			if strings.Contains(r.URL.Path, "new-container") {
				id = "new-container"
			}
			json.NewEncoder(w).Encode(docker.ContainerJSON{
				ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/app", Image: "sha256:old", HostConfig: &container.HostConfig{}, State: &docker.ContainerState{Running: true, Health: &docker.Health{Status: "healthy"}}},
				Config:            &container.Config{Image: "example/app:latest"},
			})
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(container.CreateResponse{ID: "new-container"})
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			w.Write([]byte("{\"status\":\"complete\"}\n"))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	s := &svc.ServiceContext{DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	s.HubImageInfo.Set("other-container", module.ImageCheckList{NeedUpdate: true})
	s.HubImageInfo.Set("old-container", module.ImageCheckList{NeedUpdate: true})
	if err := UpdateContainer(s, "old-container", "app", "example/app:latest", true, "test-task-123456"); err != nil {
		t.Fatal(err)
	}
	if value, ok := s.HubImageInfo.Get("other-container"); !ok || !value.NeedUpdate {
		t.Fatal("更新一个容器清空了其他容器的更新提示")
	}
	if _, ok := s.HubImageInfo.Get("old-container"); ok {
		t.Fatal("已替换容器的旧检测结果未失效")
	}
}
