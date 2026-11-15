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

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func TestUnifiedChecksCacheFailuresOnlyWithinTask(t *testing.T) {
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	var badChecks, goodChecks, mutations atomic.Int32
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/bad/") {
			badChecks.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		goodChecks.Add(1)
		w.Write([]byte(`{"config":{"digest":"sha256:old"}}`))
	}))
	defer registry.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = registry.Client().Transport
	defer func() { http.DefaultTransport = previous }()
	ref := strings.TrimPrefix(registry.URL, "https://")
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method != "GET":
			mutations.Add(1)
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			if r.URL.Query().Get("filters") != "" {
				w.Write([]byte("[]"))
				return
			}
			json.NewEncoder(w).Encode([]docker.Container{{ID: "bad-a"}, {ID: "bad-b"}, {ID: "healthy"}})
		case strings.Contains(r.URL.Path, "/images/"):
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		default:
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			repository := "/bad/app:latest"
			if id == "healthy" {
				repository = "/good/app:latest"
			}
			json.NewEncoder(w).Encode(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/" + id, Image: "sha256:old", State: &docker.ContainerState{Running: true}, HostConfig: &container.HostConfig{}}, Config: &container.Config{Image: ref + repository}})
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	for i := int32(1); i <= 2; i++ {
		// 列表中的历史结果不能作为本次更新依据。
		s.HubImageInfo.Set("healthy", module.ImageCheckList{NeedUpdate: true})
		if err := m.AutoUpdate(context.Background(), "unified"); err == nil {
			t.Fatal("仓库失败被报告为成功")
		}
		p, _ := s.GetProgress("unified")
		if !strings.Contains(p.DetailMsg, "/healthy: 已是最新镜像") || !strings.Contains(p.DetailMsg, "HTTP 503") || badChecks.Load() != i || goodChecks.Load() != i || mutations.Load() != 0 {
			t.Fatal("失败被重复请求、阻断后续对象，或复用了跨任务缓存", p.DetailMsg, badChecks.Load(), goodChecks.Load(), mutations.Load())
		}
	}
}

func TestUnifiedUpdateSkipsContainerChangedAfterDetection(t *testing.T) {
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	var scans, checks, mutations atomic.Int32
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checks.Add(1)
		w.Write([]byte(`{"config":{"digest":"sha256:new"}}`))
	}))
	defer registry.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = registry.Client().Transport
	defer func() { http.DefaultTransport = previous }()
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method != "GET":
			mutations.Add(1)
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			if r.URL.Query().Get("filters") != "" {
				w.Write([]byte("[]"))
				return
			}
			scans.Add(1)
			json.NewEncoder(w).Encode([]docker.Container{{ID: "changed"}})
		case strings.Contains(r.URL.Path, "/images/"):
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		default:
			image := "sha256:old"
			if scans.Load() >= 2 {
				image = "sha256:other"
			}
			json.NewEncoder(w).Encode(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: "changed", Name: "/changed", Image: image, State: &docker.ContainerState{Running: true}, HostConfig: &container.HostConfig{}}, Config: &container.Config{Image: strings.TrimPrefix(registry.URL, "https://") + "/example/app:latest"}})
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(t.TempDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	if err := New(s).AutoUpdate(context.Background(), "changed"); err != nil {
		t.Fatal(err)
	}
	p, _ := s.GetProgress("changed")
	if !strings.Contains(p.DetailMsg, "本次检测后已变化") || checks.Load() != 1 || mutations.Load() != 0 {
		t.Fatal("对象变化后仍使用旧结果更新或重复检测", p.DetailMsg, checks.Load(), mutations.Load())
	}
}

func TestUnifiedProjectChecksSavedImageWithoutOverwritingCurrentImageBadge(t *testing.T) {
	if os.Getenv("DOCKERCOPILOT_COMPOSE_TEST") != "1" {
		t.Skip("设置 DOCKERCOPILOT_COMPOSE_TEST=1 后使用官方 Compose 验证保存的镜像目标")
	}
	root := t.TempDir()
	t.Setenv("COMPOSE_ROOT", root)
	t.Setenv("DATA_DIR", t.TempDir())
	var currentChecks, targetChecks, mutations atomic.Int32
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/current/") {
			currentChecks.Add(1)
			w.Write([]byte(`{"config":{"digest":"sha256:new"}}`))
		} else {
			targetChecks.Add(1)
			w.Write([]byte(`{"config":{"digest":"sha256:old"}}`))
		}
	}))
	defer registry.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = registry.Client().Transport
	defer func() { http.DefaultTransport = previous }()
	ref := strings.TrimPrefix(registry.URL, "https://")
	file := filepath.Join(root, "compose.yaml")
	if err := os.WriteFile(file, []byte("services:\n  app:\n    image: "+ref+"/target/app:latest\n"), 0644); err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{projectLabel: "saved-target", serviceLabel: "app", "com.docker.compose.project.working_dir": root, "com.docker.compose.project.config_files": file}
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method != "GET":
			mutations.Add(1)
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			json.NewEncoder(w).Encode([]docker.Container{{ID: "app", State: "running", Labels: labels}})
		case strings.Contains(r.URL.Path, "/images/"):
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		default:
			json.NewEncoder(w).Encode(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: "app", Name: "/app", Image: "sha256:old", State: &docker.ContainerState{Running: true}, HostConfig: &container.HostConfig{}}, Config: &container.Config{Image: ref + "/current/app:latest", Labels: labels}})
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(node.DataDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	if err := New(s).AutoUpdate(context.Background(), "saved-target"); err != nil {
		t.Fatal(err)
	}
	result, _ := s.HubImageInfo.Get("app")
	if currentChecks.Load() != 1 || targetChecks.Load() != 1 || mutations.Load() != 0 || !result.NeedUpdate {
		t.Fatal("保存目标和当前镜像检测结果被混用", currentChecks.Load(), targetChecks.Load(), mutations.Load(), result)
	}
}
