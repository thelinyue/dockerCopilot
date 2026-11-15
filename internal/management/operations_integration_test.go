package management

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
)

func TestIsolatedConcurrentOperationsAndCleanup(t *testing.T) {
	host := os.Getenv("DOCKERCOPILOT_INTEGRATION_HOST")
	if host == "" {
		t.Skip("需要独立测试 Docker daemon；未执行真实并发验收")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	cli, err := client.NewClientWithOpts(client.WithHost(host), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	info, err := cli.Info(ctx)
	if err != nil || !strings.HasPrefix(info.DockerRootDir, "/var/tmp/dockercopilot-it-") {
		t.Fatal("拒绝非隔离测试引擎", err)
	}
	t.Setenv("DOCKER_HOST", host)
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	buildFixture(t, ctx, cli, "old", "FROM debian:bookworm-slim\nCOPY marker /marker-ready\nLABEL integration-version=old\n")
	buildFixture(t, ctx, cli, "new", "FROM debian:bookworm-slim\nCOPY marker /marker-ready\nLABEL integration-version=new\n")
	buildFixture(t, ctx, cli, "bad", "FROM scratch\nCOPY marker /marker\n")
	buildFixture(t, ctx, cli, "unhealthy", "FROM debian:bookworm-slim\nLABEL integration-version=unhealthy\n")
	registry := fixtureRegistry(t, ctx, cli)
	defer registry.Close()
	newRef := strings.TrimPrefix(registry.URL, "http://") + "/test/image:new"
	s := &svc.ServiceContext{DockerClient: cli, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	projects := []Project{}
	for _, name := range []string{"concurrent-a", "concurrent-b"} {
		dir := filepath.Join(ComposeRoot(), name)
		os.MkdirAll(dir, 0755)
		file := filepath.Join(dir, "compose.yaml")
		content := "services:\n  web:\n    image: copilot-it-fixture:old\n    command: [sleep, infinity]\n    healthcheck:\n      test: [CMD, 'true']\n      interval: 1s\n      timeout: 1s\n      retries: 30\n"
		os.WriteFile(file, []byte(content), 0644)
		p := projectFromFiles(name, dir, []string{file})
		s.UpdateProgress(name, svc.TaskProgress{Name: name})
		if err := m.ComposeAction(ctx, p, "deploy", nil, name, true); err != nil {
			t.Fatal(err)
		}
		projects = append(projects, p)
	}
	defer func() {
		for _, p := range projects {
			m.compose(context.Background(), p, "down")
		}
	}()
	a, b := projects[0], projects[1]
	beforeA, _ := m.projectContainers(ctx, a, nil)
	beforeB, _ := m.projectContainers(ctx, b, nil)
	ordinary, err := cli.ContainerCreate(ctx, &container.Config{Image: "copilot-it-fixture:old", Cmd: []string{"sleep", "infinity"}, Healthcheck: &container.HealthConfig{Test: []string{"CMD", "true"}, Interval: time.Second}}, nil, nil, nil, "concurrent-independent")
	if err != nil {
		t.Fatal(err)
	}
	defer cli.ContainerRemove(context.Background(), ordinary.ID, container.RemoveOptions{Force: true})
	if err := cli.ContainerStart(ctx, ordinary.ID, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	s.HubImageInfo.Set(ordinary.ID, module.ImageCheckList{NeedUpdate: true})
	updated := "services:\n  web:\n    image: " + newRef + "\n    command: [sleep, infinity]\n    healthcheck:\n      test: [CMD-SHELL, 'test -f /tmp/ready']\n      interval: 1s\n      timeout: 1s\n      retries: 90\n"
	os.WriteFile(a.Files[0], []byte(updated), 0644)
	id, err := s.RunTask("真实更新 A", svc.ProjectScope(a.Name, a.Directory), "update", func(id string) error { return m.ComposeAction(ctx, a, "update", []string{"web"}, id, true) })
	if err != nil {
		t.Fatal(err)
	}
	newID := ""
	for deadline := time.Now().Add(20 * time.Second); ; {
		current, _ := m.projectContainers(ctx, a, nil)
		if len(current) == 1 && current[0].ID != beforeA[0].ID && current[0].State.Running {
			newID = current[0].ID
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("没有进入真实更新验证阶段")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, _, err := s.AcquireContainer(ctx, newID, ""); !svc.IsBusy(err) {
		t.Fatal("同项目的新容器绕过互斥", err)
	}
	stopID, err := s.RunTask("停止 B", svc.ProjectScope(b.Name, b.Directory), "stop", func(id string) error { return m.ComposeAction(ctx, b, "stop", nil, id, false) })
	if err != nil {
		t.Fatal("A 阻塞了 B", err)
	}
	waitIsolatedTask(t, s, stopID)
	_, release, err := s.AcquireContainer(ctx, ordinary.ID, "")
	if err != nil {
		t.Fatal("A 阻塞了独立容器", err)
	}
	err = cli.ContainerRestart(ctx, ordinary.ID, container.StopOptions{})
	release()
	if err != nil {
		t.Fatal(err)
	}
	stopped, _ := m.projectContainers(ctx, b, nil)
	if len(stopped) != 1 || stopped[0].ID != beforeB[0].ID || stopped[0].State.Running {
		t.Fatal("B 停止失败或被替换")
	}
	exec, err := cli.ContainerExecCreate(ctx, newID, container.ExecOptions{Cmd: []string{"touch", "/tmp/ready"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerExecStart(ctx, exec.ID, container.ExecStartOptions{}); err != nil {
		t.Fatal(err)
	}
	result := waitIsolatedTask(t, s, id)
	if result.Cleanup == "" {
		t.Fatal("没有记录旧镜像清理结果")
	}
	if checked, _ := s.HubImageInfo.Get(ordinary.ID); !checked.NeedUpdate {
		t.Fatal("清除了其他容器的更新提示")
	}
	if _, _, err := cli.ImageInspectWithRaw(ctx, beforeA[0].Image); err != nil {
		t.Fatal("删除了其他运行/停止容器引用的镜像", err)
	}
	t.Log("真实并发通过：A 健康等待期间 B 停止、独立容器重启；A 的所属容器被拒绝，其他对象检测结果保留")
	// 用独有旧镜像及相同标签的拉取更新，验证实际回收本次产生的无标签镜像。
	buildFixture(t, ctx, cli, "cleanup-old", "FROM debian:bookworm-slim\nLABEL integration-cleanup=unique\n")
	old, _, _ := cli.ImageInspectWithRaw(ctx, "copilot-it-fixture:cleanup-old")
	if err := cli.ImageTag(ctx, old.ID, newRef); err != nil {
		t.Fatal(err)
	}
	if _, err := cli.ImageRemove(ctx, "copilot-it-fixture:cleanup-old", image.RemoveOptions{PruneChildren: false}); err != nil {
		t.Fatal(err)
	}
	d, err := cli.ContainerCreate(ctx, &container.Config{Image: newRef, Cmd: []string{"sleep", "infinity"}, Healthcheck: &container.HealthConfig{Test: []string{"CMD", "true"}, Interval: time.Second}}, nil, nil, nil, "concurrent-cleanup")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cli.ContainerRemove(context.Background(), "concurrent-cleanup", container.RemoveOptions{Force: true})
	}()
	if err := cli.ContainerStart(ctx, d.ID, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	v, _ := cli.ContainerInspect(ctx, d.ID)
	cleanupID, err := s.RunTask("更新并清理", svc.ContainerScope(v), "update", func(id string) error { return utiles.UpdateContainer(s, d.ID, "concurrent-cleanup", newRef, true, id) })
	if err != nil {
		t.Fatal(err)
	}
	cleaned := waitIsolatedTask(t, s, cleanupID)
	if _, _, err := cli.ImageInspectWithRaw(ctx, old.ID); !errdefs.IsNotFound(err) {
		t.Fatal("成功更新后旧镜像仍存在", err, cleaned.Cleanup)
	}
	t.Log("真实镜像清理通过：独有无标签旧镜像已删除，共用旧镜像保留")
}

func waitIsolatedTask(t *testing.T, s *svc.ServiceContext, id string) svc.TaskProgress {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; {
		p, _ := s.GetProgress(id)
		if p.IsDone {
			if p.Status != "succeeded" {
				t.Fatal(p)
			}
			return p
		}
		if time.Now().After(deadline) {
			t.Fatal("等待任务超时", p)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
