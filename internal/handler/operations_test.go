package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/golang-jwt/jwt/v4"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/management"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest"
)

func TestContainerRoutesShareProjectLocksWithoutBlockingOtherObjects(t *testing.T) {
	var mutations atomic.Int32
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			labels := map[string]string{}
			if id != "independent" {
				labels["com.docker.compose.project"] = id
				labels["com.docker.compose.project.working_dir"] = "/" + id
			}
			json.NewEncoder(w).Encode(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: id, Name: "/" + id, State: &docker.ContainerState{Running: true}}, Config: &container.Config{Labels: labels}})
		} else {
			mutations.Add(1)
			w.WriteHeader(204)
		}
	}))
	defer daemon.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(daemon.URL), client.WithVersion("1.47"))
	defer cli.Close()
	cfg := config.Config{}
	cfg.Host, cfg.Port, cfg.Auth.AccessSecret = "127.0.0.1", getFreePort(t), "operation-test-secret"
	s := &svc.ServiceContext{Config: cfg, DockerClient: cli}
	server := rest.MustNewServer(cfg.RestConf)
	RegisterHandlers(server, s, management.New(s))
	defer server.Stop()
	go server.Start()
	waitForServer(t, cfg.Port)
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte(cfg.Auth.AccessSecret))
	release := make(chan struct{})
	defer close(release)
	if _, err := s.RunTask("项目 A 更新", svc.ProjectScope("a", "/a"), "update", func(string) error { <-release; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		path   string
		status int
	}{
		{"/container/a/stop", 409}, {"/container/a/restart", 409},
		{"/container/b/stop", 200}, {"/container/independent/restart", 200},
		{"/image/sha256:unused", 409},
	} {
		method := "POST"
		if strings.HasPrefix(item.path, "/image/") {
			method = "DELETE"
		}
		req, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d/api%s", cfg.Port, item.path), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != item.status {
			t.Fatalf("%s: HTTP %d，期望 %d", item.path, resp.StatusCode, item.status)
		}
	}
	if mutations.Load() != 2 {
		t.Fatal("冲突操作调用了 Docker，或其他对象没有执行", mutations.Load())
	}
}
