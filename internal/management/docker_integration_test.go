package management

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/google/uuid"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
)

// 仅在显式指定的独立测试 daemon 上执行，绝不使用开发环境默认 Docker socket。
func TestIsolatedDockerLifecycle(t *testing.T) {
	host := os.Getenv("DOCKERCOPILOT_INTEGRATION_HOST")
	if host == "" {
		t.Skip("需要独立测试 Docker daemon；未执行真实容器验收")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cli, err := client.NewClientWithOpts(client.WithHost(host), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	info, err := cli.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(info.DockerRootDir, "/var/tmp/dockercopilot-it-") {
		t.Fatal("拒绝在非隔离 Docker data-root 执行", info.DockerRootDir)
	}
	t.Setenv("DOCKER_HOST", host)
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("COMPOSE_ROOT", t.TempDir())
	settings, _ := node.OpenSettings(node.DataDir())
	devices, _ := node.OpenDevices(node.DataDir())
	s := &svc.ServiceContext{DockerClient: cli, Settings: settings, Devices: devices, HubImageInfo: module.NewImageCheck()}
	m := New(s)
	label := "com.dockercopilot.integration"
	volumes := []string{}
	networkID := ""
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), time.Minute)
		defer done()
		list, _ := cli.ContainerList(cleanup, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", label+"=true"))})
		for _, c := range list {
			cli.ContainerRemove(cleanup, c.ID, container.RemoveOptions{Force: true, RemoveVolumes: true})
		}
		for _, v := range volumes {
			cli.VolumeRemove(cleanup, v, true)
		}
		if networkID != "" {
			cli.NetworkRemove(cleanup, networkID)
		}
	})
	buildFixture(t, ctx, cli, "old", "FROM debian:bookworm-slim\nCOPY marker /marker-ready\nLABEL integration-version=old\n")
	buildFixture(t, ctx, cli, "new", "FROM debian:bookworm-slim\nCOPY marker /marker-ready\nLABEL integration-version=new\n")
	buildFixture(t, ctx, cli, "bad", "FROM scratch\nCOPY marker /marker\nLABEL integration-version=bad\n")
	buildFixture(t, ctx, cli, "unhealthy", "FROM debian:bookworm-slim\nLABEL integration-version=unhealthy\n")
	registry := fixtureRegistry(t, ctx, cli)
	defer registry.Close()
	registryImage := strings.TrimPrefix(registry.URL, "http://") + "/test/image:"
	netName := "dc-it-" + uuid.NewString()[:8]
	netCreated, err := cli.NetworkCreate(ctx, netName, network.CreateOptions{Driver: "bridge", Internal: true, IPAM: &network.IPAM{Config: []network.IPAMConfig{{Subnet: "172.30.198.0/24"}}}})
	if err != nil {
		t.Fatal(err)
	}
	networkID = netCreated.ID
	config := &container.Config{Image: "copilot-it-fixture:old", Hostname: "preserved-host", Cmd: []string{"sleep", "infinity"}, Env: []string{"SENTINEL=original"}, Labels: map[string]string{label: "true"}, Volumes: map[string]struct{}{"/state": {}}, Healthcheck: &container.HealthConfig{Test: []string{"CMD-SHELL", "test -f /marker-ready"}, Interval: time.Second, Timeout: time.Second, Retries: 1}}
	created, err := cli.ContainerCreate(ctx, config, &container.HostConfig{NetworkMode: container.NetworkMode(netName)}, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: "172.30.198.9"}, Aliases: []string{"service-alias"}}}}, nil, "dc-it-ordinary")
	if err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := utiles.WaitContainer(ctx, s, created.ID); err != nil {
		t.Fatal(err)
	}
	old, _ := cli.ContainerInspect(ctx, created.ID)
	volumes = append(volumes, old.Mounts[0].Name)
	id := uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "ordinary success"})
	if err := utiles.UpdateContainer(s, created.ID, "ignored", registryImage+"new", true, id); err != nil {
		t.Fatal(err)
	}
	current, err := cli.ContainerInspect(ctx, "dc-it-ordinary")
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimePreserved(t, old, current, netName)
	newImage, _, _ := cli.ImageInspectWithRaw(ctx, "copilot-it-fixture:new")
	if current.Image != newImage.ID {
		t.Fatal("new image not applied")
	}
	t.Log("ordinary update passed: image, anonymous volume, hostname, environment and static network preserved")
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "ordinary rollback"})
	if err := utiles.UpdateContainer(s, current.ID, "ignored", registryImage+"bad", true, id); err == nil {
		t.Fatal("expected new image startup failure")
	}
	recovered, err := cli.ContainerInspect(ctx, "dc-it-ordinary")
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimePreserved(t, current, recovered, netName)
	p, _ := s.GetProgress(id)
	if p.Status != "rolled_back" || recovered.Image != current.Image || !recovered.State.Running {
		t.Fatal("ordinary rollback did not restore old runtime", p, recovered.Image)
	}
	t.Log("ordinary failure passed: old container recovered and data volume retained")
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "ordinary health rollback"})
	if err := utiles.UpdateContainer(s, recovered.ID, "ignored", registryImage+"unhealthy", true, id); err == nil {
		t.Fatal("expected health failure")
	}
	healthRestored, err := cli.ContainerInspect(ctx, "dc-it-ordinary")
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimePreserved(t, recovered, healthRestored, netName)
	p, _ = s.GetProgress(id)
	if p.Status != "rolled_back" || healthRestored.Image != recovered.Image || !healthRestored.State.Running {
		t.Fatal("health failure was not restored", p)
	}
	t.Log("ordinary health failure passed: running but unhealthy replacement rejected and old runtime restored")
	if err := cli.ContainerRemove(ctx, recovered.ID, container.RemoveOptions{Force: true}); err != nil {
		t.Fatal(err)
	}
	// Compose 的失败目标修改环境和命令，恢复必须来自实际容器，不能使用编辑后的文件。
	dir := filepath.Join(ComposeRoot(), "app")
	os.MkdirAll(dir, 0755)
	composePath := filepath.Join(dir, "compose.yaml")
	good := "name: dc-it-compose\nservices:\n  app:\n    image: copilot-it-fixture:old\n    pull_policy: never\n    command: [sleep, infinity]\n    hostname: compose-original\n    environment:\n      SENTINEL: original\n    labels:\n      " + label + ": 'true'\n    volumes:\n      - /state\n    healthcheck:\n      test: [CMD, 'true']\n      interval: 1s\n      timeout: 1s\n      retries: 1\n"
	os.WriteFile(composePath, []byte(good), 0644)
	project := projectFromFiles("dc-it-compose", dir, []string{composePath})
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "compose deploy"})
	if err := m.ComposeAction(ctx, project, "deploy", nil, id, true); err != nil {
		t.Fatal(err)
	}
	before, err := m.projectContainers(ctx, project, nil)
	if err != nil || len(before) != 1 {
		t.Fatal(err, len(before))
	}
	volumes = append(volumes, before[0].Mounts[0].Name)
	validNew := strings.Replace(good, "copilot-it-fixture:old", registryImage+"new", 1)
	os.WriteFile(composePath, []byte(validNew), 0644)
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "compose success"})
	if err := m.ComposeAction(ctx, project, "update", []string{"app"}, id, true); err != nil {
		t.Fatal(err)
	}
	updated, _ := m.projectContainers(ctx, project, nil)
	if len(updated) != 1 || updated[0].Image != newImage.ID || updated[0].Mounts[0].Name != before[0].Mounts[0].Name {
		t.Fatal("Compose successful update did not preserve volume")
	}
	t.Log("Compose deployment and image replacement passed with original anonymous volume")
	// 完整 config 校验失败时，运行中的容器不得被改动。
	os.WriteFile(composePath, []byte("services:\n  app:\n    image: nginx\n    invalid-property: true\n"), 0644)
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "invalid compose"})
	if err := m.ComposeAction(ctx, project, "deploy", nil, id, true); err == nil {
		t.Fatal("invalid model accepted")
	}
	unchanged, _ := m.projectContainers(ctx, project, nil)
	if len(unchanged) != 1 || unchanged[0].ID != updated[0].ID || !unchanged[0].State.Running {
		t.Fatal("config failure touched running service")
	}
	bad := strings.Replace(validNew, "command: [sleep, infinity]", "command: [missing-command]", 1)
	bad = strings.Replace(bad, "SENTINEL: original", "SENTINEL: edited", 1)
	os.WriteFile(composePath, []byte(bad), 0644)
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "compose rollback"})
	if err := m.ComposeAction(ctx, project, "deploy", nil, id, true); err == nil {
		t.Fatal("expected compose startup failure")
	}
	restored, err := m.projectContainers(ctx, project, nil)
	if err != nil || len(restored) != 1 {
		t.Fatal(err, len(restored))
	}
	if restored[0].Image != updated[0].Image || restored[0].Mounts[0].Name != updated[0].Mounts[0].Name || !node.Contains(restored[0].Config.Env, "SENTINEL=original") || !restored[0].State.Running {
		t.Fatal("Compose rollback reused desired config instead of actual snapshot")
	}
	p, _ = s.GetProgress(id)
	if p.Status != "rolled_back" {
		t.Fatal(p)
	}
	text, _ := os.ReadFile(composePath)
	if string(text) != bad {
		t.Fatal("rollback changed user's Compose edits")
	}
	t.Log("Compose failure passed: actual old environment, image and volume restored; edited file retained")
	unhealthy := strings.Replace(validNew, "test: [CMD, 'true']", "test: [CMD, 'false']", 1)
	os.WriteFile(composePath, []byte(unhealthy), 0644)
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "compose health rollback"})
	if err := m.ComposeAction(ctx, project, "deploy", nil, id, true); err == nil {
		t.Fatal("expected Compose health failure")
	}
	healthContainers, err := m.projectContainers(ctx, project, nil)
	p, _ = s.GetProgress(id)
	if err != nil || len(healthContainers) != 1 || p.Status != "rolled_back" || !healthContainers[0].State.Running || healthContainers[0].Mounts[0].Name != updated[0].Mounts[0].Name || healthContainers[0].Config.Healthcheck.Test[1] != "true" {
		t.Fatal("Compose health rollback failed", err, p)
	}
	t.Log("Compose health failure passed: previous healthcheck, volume and actual runtime restored")

	pathDir := filepath.Join(ComposeRoot(), "paths")
	os.MkdirAll(filepath.Join(pathDir, "data"), 0755)
	os.WriteFile(filepath.Join(pathDir, ".env"), []byte("FIXTURE_IMAGE=copilot-it-fixture:old\n"), 0600)
	os.WriteFile(filepath.Join(pathDir, "app.env"), []byte("FROM_ENV_FILE=retained\n"), 0600)
	mainPath, overridePath := filepath.Join(pathDir, "compose.yaml"), filepath.Join(pathDir, "compose.override.json")
	os.WriteFile(mainPath, []byte("services:\n  app:\n    image: ${FIXTURE_IMAGE}\n    env_file: ./app.env\n    volumes:\n      - ./data:/state\n"), 0644)
	os.WriteFile(overridePath, []byte(`{"services":{"app":{"environment":{"OVERRIDE":"retained"}}}}`), 0644)
	pathProject := projectFromFiles("dc-it-paths", pathDir, []string{mainPath, overridePath})
	modelJSON, err := m.compose(ctx, pathProject, "config", "--format", "json")
	if err != nil {
		t.Fatal(err)
	}
	var resolved struct {
		Services map[string]struct {
			Image       string
			Environment map[string]string
			Volumes     []struct{ Source string }
		}
	}
	if err := json.Unmarshal(modelJSON, &resolved); err != nil {
		t.Fatal(err)
	}
	app := resolved.Services["app"]
	if app.Image != "copilot-it-fixture:old" || app.Environment["FROM_ENV_FILE"] != "retained" || app.Environment["OVERRIDE"] != "retained" || len(app.Volumes) != 1 || app.Volumes[0].Source != filepath.Join(pathDir, "data") {
		t.Fatal("relative Compose inputs resolved incorrectly")
	}
	t.Log("official Compose path resolution passed: .env, env_file, ordered JSON override and relative volume")

	// 多副本中任意一个被排除，整个服务必须在检测/拉取前跳过。
	os.WriteFile(composePath, []byte(validNew), 0644)
	if _, err := m.compose(ctx, project, "up", "-d", "--no-build", "--pull", "never", "--wait", "--scale", "app=2", "app"); err != nil {
		t.Fatal(err)
	}
	projects, err := m.Projects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var group Service
	for _, p := range projects {
		if p.ID == project.ID {
			group = p.Services[0]
		}
	}
	if group.Running != 2 {
		t.Fatal("未建立多副本验收环境", group)
	}
	settingsValue := s.Settings.Get()
	all, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range all {
		if c.Labels[label] != "true" {
			settingsValue.ExcludedContainers = append(settingsValue.ExcludedContainers, c.ID)
		}
	}
	settingsValue.ExcludedContainers = append(settingsValue.ExcludedContainers, group.Containers[len(group.Containers)-1])
	if err := s.Settings.Save(settingsValue); err != nil {
		t.Fatal(err)
	}
	s.HubImageInfo.Clear()
	id = uuid.NewString()
	s.UpdateProgress(id, svc.TaskProgress{Name: "replica exclusion"})
	if err := m.AutoUpdate(ctx, id); err != nil {
		t.Fatal(err)
	}
	afterExclusion, _ := m.projectContainers(ctx, project, nil)
	if len(afterExclusion) != 2 {
		t.Fatal("排除规则改变了副本数")
	}
	for _, v := range afterExclusion {
		if _, checked := s.HubImageInfo.Get(v.ID); checked || !v.State.Running || !node.Contains(group.Containers, v.ID) {
			t.Fatal("被排除服务仍被检测或更新")
		}
	}
	t.Log("automatic exclusion passed: one excluded replica skipped the whole service before metadata requests; running replicas retained")
}

func assertRuntimePreserved(t *testing.T, old, current types.ContainerJSON, networkName string) {
	t.Helper()
	if old.Mounts[0].Name != current.Mounts[0].Name || old.Config.Hostname != current.Config.Hostname || !node.Contains(current.Config.Env, "SENTINEL=original") {
		t.Fatal("runtime or volume changed")
	}
	if current.NetworkSettings.Networks[networkName].IPAddress != "172.30.198.9" {
		t.Fatal("static IP not preserved")
	}
}

func buildFixture(t *testing.T, ctx context.Context, cli *client.Client, tag, dockerfile string) {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0644, Size: int64(len(dockerfile))})
	tw.Write([]byte(dockerfile))
	tw.WriteHeader(&tar.Header{Name: "marker", Mode: 0644, Size: 7})
	tw.Write([]byte("fixture"))
	tw.Close()
	response, err := cli.ImageBuild(ctx, &b, types.ImageBuildOptions{Tags: []string{"copilot-it-fixture:" + tag}, Dockerfile: "Dockerfile", Remove: true, Version: types.BuilderV1})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(response.Body)
	for {
		var msg jsonmessage.JSONMessage
		err := decoder.Decode(&msg)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if msg.Error != nil {
			t.Fatal(msg.Error)
		}
	}
}

func sumDigest(b []byte) string { s := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(s[:]) }

// 从独立 daemon 中已有的本地镜像生成测试 registry；不从公网拉取任何镜像。
func fixtureRegistry(t *testing.T, ctx context.Context, cli *client.Client) *httptest.Server {
	t.Helper()
	archive, err := cli.ImageSave(ctx, []string{"copilot-it-fixture:old", "copilot-it-fixture:new", "copilot-it-fixture:bad", "copilot-it-fixture:unhealthy"})
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	files := map[string][]byte{}
	tr := tar.NewReader(archive)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			b, err := io.ReadAll(tr)
			if err != nil {
				t.Fatal(err)
			}
			files[h.Name] = b
		}
	}
	var entries []struct {
		Config   string
		RepoTags []string
		Layers   []string
	}
	if err := json.Unmarshal(files["manifest.json"], &entries); err != nil {
		t.Fatal("unsupported fixture archive", err)
	}
	blobs := map[string][]byte{}
	manifests := map[string][]byte{}
	compressed := map[string]string{}
	for _, entry := range entries {
		config := files[entry.Config]
		configDigest := sumDigest(config)
		blobs[configDigest] = config
		layers := []map[string]any{}
		for _, layer := range entry.Layers {
			raw := files[layer]
			key := sumDigest(raw)
			digest, ok := compressed[key]
			if !ok {
				var zipped bytes.Buffer
				gz, _ := gzip.NewWriterLevel(&zipped, gzip.BestSpeed)
				gz.Write(raw)
				gz.Close()
				digest = sumDigest(zipped.Bytes())
				blobs[digest] = zipped.Bytes()
				compressed[key] = digest
			}
			layers = append(layers, map[string]any{"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip", "digest": digest, "size": len(blobs[digest])})
		}
		manifest, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": "application/vnd.docker.distribution.manifest.v2+json", "config": map[string]any{"mediaType": "application/vnd.docker.container.image.v1+json", "digest": configDigest, "size": len(config)}, "layers": layers})
		for _, tag := range entry.RepoTags {
			_, suffix, _ := strings.Cut(tag, ":")
			manifests[suffix] = manifest
		}
		manifests[sumDigest(manifest)] = manifest
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		if r.URL.Path == "/v2/" {
			io.WriteString(w, "{}")
			return
		}
		if _, tag, ok := strings.Cut(r.URL.Path, "/manifests/"); ok {
			b, exists := manifests[tag]
			if !exists {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.docker.distribution.manifest.v2+json")
			w.Header().Set("Docker-Content-Digest", sumDigest(b))
			http.ServeContent(w, r, "manifest", time.Time{}, bytes.NewReader(b))
			return
		}
		if _, digest, ok := strings.Cut(r.URL.Path, "/blobs/"); ok {
			b, exists := blobs[digest]
			if !exists {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Docker-Content-Digest", digest)
			http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(b))
			return
		}
		http.NotFound(w, r)
	}))
}
