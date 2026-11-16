package management

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/jsonmessage"
	containerlogic "github.com/onlyLTY/dockerCopilot/internal/logic/container"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
)

// 复用静态运行 fixture，在全新的独立引擎离线验证设置到真实容器生命周期的接入。
func TestIsolatedRuntimeRetention(t *testing.T) {
	host := os.Getenv("DOCKERCOPILOT_INTEGRATION_HOST")
	if host == "" {
		t.Skip("需要独立 Docker daemon 和 DOCKERCOPILOT_PRUNE_RUNNER；未执行真实保留策略验收")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cli, err := client.NewClientWithOpts(client.WithHost(host), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	info, err := cli.Info(ctx)
	if err != nil || !strings.HasPrefix(info.DockerRootDir, "/var/tmp/dockercopilot-it-") {
		t.Fatal("拒绝在非隔离 Docker data-root 执行", err)
	}
	runner, err := os.ReadFile(os.Getenv("DOCKERCOPILOT_PRUNE_RUNNER"))
	if err != nil {
		t.Fatal("需要本地编译的静态 Linux 运行 fixture", err)
	}
	for _, tag := range []string{"old", "new", "bad", "unhealthy"} {
		file := "FROM scratch\nCOPY runner /runner\nCMD [\"/runner\"]\nLABEL retention.version=" + tag + "\n"
		if tag == "bad" {
			// 更新保留旧容器的 Cmd；缺少该程序才能可靠触发实际启动失败。
			file = strings.Replace(file, "COPY runner /runner", "COPY runner /other-runner", 1)
		}
		var source bytes.Buffer
		tw := tar.NewWriter(&source)
		for _, entry := range []struct {
			name string
			data []byte
			mode int64
		}{{"Dockerfile", []byte(file), 0644}, {"runner", runner, 0755}} {
			if err := tw.WriteHeader(&tar.Header{Name: entry.name, Mode: entry.mode, Size: int64(len(entry.data))}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write(entry.data); err != nil {
				t.Fatal(err)
			}
		}
		tw.Close()
		response, err := cli.ImageBuild(ctx, &source, docker.ImageBuildOptions{Tags: []string{"copilot-it-fixture:" + tag}, Remove: true, Version: docker.BuilderV1, NetworkMode: "none"})
		if err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(response.Body)
		for {
			var message jsonmessage.JSONMessage
			if err := decoder.Decode(&message); err == io.EOF {
				break
			} else if err != nil {
				response.Body.Close()
				t.Fatal(err)
			}
			if message.Error != nil {
				response.Body.Close()
				t.Fatal(message.Error)
			}
		}
		response.Body.Close()
	}
	registry := fixtureRegistry(t, ctx, cli)
	defer registry.Close()
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, HubImageInfo: module.NewImageCheck()}
	const label = "com.dockercopilot.retention-test"
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), time.Minute)
		defer done()
		list, _ := cli.ContainerList(cleanup, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", label+"=true"))})
		for _, item := range list {
			cli.ContainerRemove(cleanup, item.ID, container.RemoveOptions{Force: true})
		}
	})
	created, err := cli.ContainerCreate(ctx, &container.Config{Image: "copilot-it-fixture:old", Labels: map[string]string{label: "true"}}, &container.HostConfig{NetworkMode: "none"}, nil, nil, "runtime-retention-app")
	if err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	update := func(tag string) svc.TaskProgress {
		t.Helper()
		current, err := cli.ContainerInspect(ctx, "runtime-retention-app")
		if err != nil {
			t.Fatal(err)
		}
		response, err := containerlogic.NewUpdateLogic(ctx, s).Update(&types.ContainerUpdateReq{IdReq: types.IdReq{Id: current.ID}, ImageNameAndTag: strings.TrimPrefix(registry.URL, "http://") + "/test/image:" + tag})
		if err != nil {
			t.Fatal(err)
		}
		id := response.Data.(map[string]string)["taskID"]
		for {
			progress, _ := s.GetProgress(id)
			if progress.IsDone {
				return progress
			}
			select {
			case <-ctx.Done():
				t.Fatal("等待真实更新超时", ctx.Err())
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	if err := settings.Patch(json.RawMessage(`{"keepOldContainer":true}`)); err != nil {
		t.Fatal(err)
	}
	if progress := update("new"); progress.Status != "succeeded" {
		t.Fatal(progress)
	}
	kept, err := cli.ContainerInspect(ctx, created.ID)
	if err != nil || kept.State.Running || !strings.HasPrefix(kept.Name, "/runtime-retention-app-old-") {
		t.Fatal("旧容器未停止并改名保留", err)
	}
	beforeDelete, _ := cli.ContainerInspect(ctx, "runtime-retention-app")
	if err := settings.Patch(json.RawMessage(`{"keepOldContainer":false}`)); err != nil {
		t.Fatal(err)
	}
	if progress := update("old"); progress.Status != "succeeded" {
		t.Fatal(progress)
	}
	if _, err := cli.ContainerInspect(ctx, beforeDelete.ID); !errdefs.IsNotFound(err) {
		t.Fatal("关闭保留后旧容器仍存在", err)
	}
	if _, err := cli.ContainerInspect(ctx, created.ID); err != nil {
		t.Fatal("后续更新清理了此前已保留的容器", err)
	}
	beforeFailure, _ := cli.ContainerInspect(ctx, "runtime-retention-app")
	if progress := update("bad"); progress.Status != "rolled_back" {
		t.Fatal("更新失败未恢复旧容器", progress)
	}
	restored, err := cli.ContainerInspect(ctx, "runtime-retention-app")
	if err != nil || restored.ID != beforeFailure.ID || !restored.State.Running {
		t.Fatal("失败恢复未恢复原运行容器", err)
	}
	t.Log("真实 Docker 保留、删除及启动失败恢复通过；全程使用本地静态 fixture，未拉取公网镜像")
}
