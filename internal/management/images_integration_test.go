package management

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

// 清理测试只能使用全新的独立 daemon，不能在开发引擎上删除用户镜像。
func TestIsolatedImagePrune(t *testing.T) {
	host := os.Getenv("DOCKERCOPILOT_INTEGRATION_HOST")
	if host == "" {
		t.Skip("需要独立测试 Docker daemon；未执行真实镜像清理验收")
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
	before, err := cli.ImageList(ctx, image.ListOptions{All: true})
	if err != nil || len(before) != 0 {
		t.Fatal("清理验收需要空白测试引擎", err)
	}
	runner, err := os.ReadFile(os.Getenv("DOCKERCOPILOT_PRUNE_RUNNER"))
	if err != nil {
		t.Fatal("需要本地编译的静态 Linux 运行 fixture", err)
	}
	ids := map[string]string{}
	for _, role := range []string{"unused", "stopped", "running", "dangling-unused", "dangling-used"} {
		ref := "copilot-prune-fixture:" + role
		var source bytes.Buffer
		tarWriter := tar.NewWriter(&source)
		file := "FROM scratch\nCOPY runner /runner\nCMD [\"/runner\"]\nLABEL prune.role=" + role + "\n"
		for _, entry := range []struct {
			name string
			data []byte
			mode int64
		}{{"Dockerfile", []byte(file), 0644}, {"runner", runner, 0755}} {
			tarWriter.WriteHeader(&tar.Header{Name: entry.name, Size: int64(len(entry.data)), Mode: entry.mode})
			tarWriter.Write(entry.data)
		}
		tarWriter.Close()
		build, err := cli.ImageBuild(ctx, &source, types.ImageBuildOptions{Tags: []string{ref}, Remove: true, Version: types.BuilderV1, NetworkMode: "none"})
		if err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(build.Body)
		for {
			var message jsonmessage.JSONMessage
			if err := decoder.Decode(&message); err == io.EOF {
				break
			} else if err != nil {
				build.Body.Close()
				t.Fatal(err)
			}
			if message.Error != nil {
				build.Body.Close()
				t.Fatal(message.Error)
			}
		}
		build.Body.Close()
		inspect, _, err := cli.ImageInspectWithRaw(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		ids[role] = inspect.ID
	}
	containers := map[string]string{}
	for _, role := range []string{"stopped", "running", "dangling-used"} {
		created, err := cli.ContainerCreate(ctx, &container.Config{Image: ids[role]}, &container.HostConfig{NetworkMode: "none"}, nil, nil, "copilot-prune-"+role)
		if err != nil {
			t.Fatal(err)
		}
		containers[role] = created.ID
		t.Cleanup(func() { cli.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true}) })
		if role == "running" {
			if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, tag := range []string{"alias", "dangling-unused", "dangling-used"} {
		if err := cli.ImageTag(ctx, ids["unused"], "copilot-prune-fixture:"+tag); err != nil {
			t.Fatal(err)
		}
	}
	// 先重现原实现的多标签冲突，再验证修复不会依赖 force 删除。
	if _, err := cli.ImageRemove(ctx, ids["unused"], image.RemoveOptions{Force: false}); !errdefs.IsConflict(err) {
		t.Fatal("没有重现多标签镜像按 ID 删除冲突", err)
	}
	m := New(&svc.ServiceContext{DockerClient: cli})
	prune := func(kind string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/api/image/prune", strings.NewReader(`{"type":"`+kind+`"}`)).WithContext(ctx)
		m.pruneImages(w, r)
		var response struct {
			Data map[string]any `json:"data"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
			t.Fatal("实际清理失败", w.Code, w.Body.String())
		}
		return response.Data
	}
	prune("dangling")
	if _, _, err := cli.ImageInspectWithRaw(ctx, ids["dangling-unused"]); !errdefs.IsNotFound(err) {
		t.Fatal("未使用的无Tag镜像未清理", err)
	}
	if _, _, err := cli.ImageInspectWithRaw(ctx, ids["unused"]); err != nil {
		t.Fatal("无Tag清理不应删除带标签镜像", err)
	}
	prune("unused")
	if _, _, err := cli.ImageInspectWithRaw(ctx, ids["unused"]); !errdefs.IsNotFound(err) {
		t.Fatal("多标签未使用镜像未清理", err)
	}
	for role, id := range containers {
		inspect, err := cli.ContainerInspect(ctx, id)
		if err != nil || inspect.Image != ids[role] || inspect.State.Running != (role == "running") {
			t.Fatal("容器状态被清理影响", role, err)
		}
		if _, _, err := cli.ImageInspectWithRaw(ctx, ids[role]); err != nil {
			t.Fatal("运行中或已停止容器的镜像被清理", role, err)
		}
	}
	if report := prune("unused"); report["changed"] != false || report["spaceReclaimed"] != float64(0) {
		t.Fatal("重复清理应如实报告无可回收内容", report)
	}
	t.Log("已重现多标签冲突；无Tag/全部未使用清理、运行与停止容器引用保护及重复清理通过")
}
