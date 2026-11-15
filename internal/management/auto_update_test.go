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

func TestAutoUpdateSkipsBusyStoppedAndMixedServicesButContinues(t *testing.T) {
	root := t.TempDir()
	t.Setenv("COMPOSE_ROOT", root)
	t.Setenv("DATA_DIR", t.TempDir())
	objects := map[string]docker.ContainerJSON{}
	for _, id := range []string{"busy", "stopped", "healthy", "partial-running", "partial-stopped"} {
		labels := map[string]string{}
		running := id != "stopped" && id != "partial-stopped"
		if strings.HasPrefix(id, "partial-") {
			labels[projectLabel], labels[serviceLabel] = "partial", "app"
			labels["com.docker.compose.project.working_dir"] = filepath.Join(root, "partial")
			labels["com.docker.compose.project.config_files"] = filepath.Join(root, "partial", "compose.yaml")
		}
		objects[id] = docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/" + id, Image: "sha256:old", State: &docker.ContainerState{Running: running}, HostConfig: &container.HostConfig{}}, Config: &container.Config{Image: "example/app@sha256:" + strings.Repeat("a", 64), Labels: labels}}
	}
	for _, name := range []string{"partial", "never-deployed"} {
		os.MkdirAll(filepath.Join(root, name), 0755)
		os.WriteFile(filepath.Join(root, name, "compose.yaml"), []byte("services: {}\n"), 0644)
	}
	var mutations, images atomic.Int32
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "GET" {
			mutations.Add(1)
			w.WriteHeader(500)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/containers/json") {
			list := []docker.Container{}
			projectOnly := r.URL.Query().Get("filters") != ""
			for id, v := range objects {
				if projectOnly && v.Config.Labels[projectLabel] == "" {
					continue
				}
				state := "exited"
				if v.State.Running {
					state = "running"
				}
				list = append(list, docker.Container{ID: id, State: state, Labels: v.Config.Labels})
			}
			json.NewEncoder(w).Encode(list)
		} else if strings.Contains(r.URL.Path, "/images/") {
			images.Add(1)
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		} else {
			parts := strings.Split(r.URL.Path, "/")
			json.NewEncoder(w).Encode(objects[parts[len(parts)-2]])
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(node.DataDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	s.UpdateProgress("auto", svc.TaskProgress{Name: "auto"})
	s.HubImageInfo.Set("stopped", module.ImageCheckList{NeedUpdate: true})
	release, err := s.Acquire(svc.ContainerScope(objects["busy"]))
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := m.AutoUpdate(context.Background(), "auto"); err != nil {
		t.Fatal(err)
	}
	p, _ := s.GetProgress("auto")
	if !strings.Contains(p.DetailMsg, "busy: 已跳过") || !strings.Contains(p.DetailMsg, "/healthy: 已是最新") || !strings.Contains(p.DetailMsg, "包含停止副本") || p.Resource != nil {
		t.Fatal(p)
	}
	if mutations.Load() != 0 || images.Load() != 1 {
		t.Fatal("停止或忙碌对象仍被检测/变更，或后续运行对象未处理", mutations.Load(), images.Load())
	}
	if result, _ := s.HubImageInfo.Get("stopped"); !result.NeedUpdate {
		t.Fatal("停止容器的更新提示被清除")
	}
	if err := m.Check(context.Background(), "check"); err != nil {
		t.Fatal(err)
	}
	for id := range objects {
		if _, ok := s.HubImageInfo.Get(id); !ok {
			t.Fatal("未检测停止或运行容器", id)
		}
	}
}

func TestLateCheckDoesNotRestoreReplacedContainerResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: "same", Image: "sha256:new"}, Config: &container.Config{Image: "example/app:latest"}})
	}))
	defer server.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	defer cli.Close()
	s := &svc.ServiceContext{DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	m.storeCheck(context.Background(), docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: "same", Image: "sha256:old"}, Config: &container.Config{Image: "example/app:latest"}}, module.ImageCheckList{NeedUpdate: true})
	if _, ok := s.HubImageInfo.Get("same"); ok {
		t.Fatal("已失效的检测结果重新出现")
	}
}

func TestAutoUpdateContinuesAfterOneUpdateFails(t *testing.T) {
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	t.Setenv("DATA_DIR", t.TempDir())
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"config":{"digest":"sha256:new"}}`))
	}))
	defer registry.Close()
	// 仅信任此测试仓库的 CA；生产路径仍使用标准证书校验。
	previousTransport := http.DefaultTransport
	http.DefaultTransport = registry.Client().Transport
	defer func() { http.DefaultTransport = previousTransport }()
	imageRef := strings.TrimPrefix(registry.URL, "https://") + "/example/app:latest"
	var pulls atomic.Int32
	var updated atomic.Bool
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			json.NewEncoder(w).Encode([]docker.Container{{ID: "failed", ImageID: "sha256:old"}, {ID: "healthy", ImageID: "sha256:old"}})
		case strings.Contains(r.URL.Path, "/images/") && r.Method == "GET":
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			if pulls.Add(1) == 1 {
				w.WriteHeader(500)
				w.Write([]byte(`{"message":"fixture pull failed"}`))
			} else {
				w.Write([]byte("{\"status\":\"complete\"}\n"))
			}
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			updated.Store(true)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(container.CreateResponse{ID: "replacement"})
		case r.Method == "GET":
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			json.NewEncoder(w).Encode(docker.ContainerJSON{
				ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/" + id, Image: "sha256:old", HostConfig: &container.HostConfig{}, State: &docker.ContainerState{Running: true, Health: &docker.Health{Status: "healthy"}}},
				Config:            &container.Config{Image: imageRef},
			})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(node.DataDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	s.UpdateProgress("auto-task", svc.TaskProgress{Name: "auto"})
	err := New(s).AutoUpdate(context.Background(), "auto-task")
	p, _ := s.GetProgress("auto-task")
	if err == nil || !strings.Contains(p.DetailMsg, "/failed: 拉取镜像失败") || !strings.Contains(p.DetailMsg, "/healthy: 已更新") || !updated.Load() || pulls.Load() != 2 {
		t.Fatal("一项更新失败阻止了后续对象，或最终结果没有汇总失败", err, p, pulls.Load())
	}
	release, err := s.Acquire(svc.OperationScope{})
	if err != nil {
		t.Fatal("更新结束后仍占用节点", err)
	}
	release()
}

func TestAutoUpdatePartiallyRunningProjectChecksOnlyEligibleService(t *testing.T) {
	if os.Getenv("DOCKERCOPILOT_COMPOSE_TEST") != "1" {
		t.Skip("设置 DOCKERCOPILOT_COMPOSE_TEST=1 后使用官方 Compose 验证部分运行项目")
	}
	root := t.TempDir()
	t.Setenv("COMPOSE_ROOT", root)
	t.Setenv("DATA_DIR", t.TempDir())
	file := filepath.Join(root, "compose.yaml")
	imageRef := "example/app@sha256:" + strings.Repeat("a", 64)
	os.WriteFile(file, []byte("services:\n  active:\n    image: "+imageRef+"\n  idle:\n    image: "+imageRef+"\n  mixed:\n    image: "+imageRef+"\n"), 0644)
	objects := map[string]docker.ContainerJSON{}
	for _, id := range []string{"active", "idle", "mixed-running", "mixed-stopped"} {
		service := strings.Split(id, "-")[0]
		objects[id] = docker.ContainerJSON{
			ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/" + id, Image: "sha256:old", HostConfig: &container.HostConfig{}, State: &docker.ContainerState{Running: id == "active" || id == "mixed-running"}},
			Config: &container.Config{Image: imageRef, Labels: map[string]string{
				projectLabel: "partial", serviceLabel: service,
				"com.docker.compose.project.working_dir": root, "com.docker.compose.project.config_files": file,
			}},
		}
	}
	var checks, mutations atomic.Int32
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method != "GET":
			mutations.Add(1)
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			list := []docker.Container{}
			for id, v := range objects {
				state := "exited"
				if v.State.Running {
					state = "running"
				}
				list = append(list, docker.Container{ID: id, State: state, Labels: v.Config.Labels})
			}
			json.NewEncoder(w).Encode(list)
		case strings.Contains(r.URL.Path, "/images/"):
			checks.Add(1)
			json.NewEncoder(w).Encode(docker.ImageInspect{Os: "linux", Architecture: "amd64"})
		default:
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			if id != "active" {
				t.Error("自动更新检查了停止服务或含停止副本的服务", id)
			}
			json.NewEncoder(w).Encode(objects[id])
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	settings, _ := node.OpenSettings(node.DataDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	s.UpdateProgress("partial-task", svc.TaskProgress{Name: "auto"})
	if err := New(s).AutoUpdate(context.Background(), "partial-task"); err != nil {
		t.Fatal(err)
	}
	p, _ := s.GetProgress("partial-task")
	if checks.Load() != 1 || mutations.Load() != 0 || !strings.Contains(p.DetailMsg, "partial/active: 无更新") || !strings.Contains(p.DetailMsg, "partial/idle: 已跳过") || !strings.Contains(p.DetailMsg, "partial/mixed: 已跳过") {
		t.Fatal("部分运行项目未按服务分别处理", p, checks.Load(), mutations.Load())
	}
}
