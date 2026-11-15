package utiles

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func TestContainerMutationsHonorRequestDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	cli, _ := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	defer cli.Close()
	s := &svc.ServiceContext{DockerClient: cli}
	for name, run := range map[string]func(context.Context) error{
		"start":   func(ctx context.Context) error { return StartContainer(ctx, s, "app") },
		"stop":    func(ctx context.Context) error { return StopContainer(ctx, s, "app") },
		"restart": func(ctx context.Context) error { return RestartContainer(ctx, s, "app") },
		"rename":  func(ctx context.Context) error { return RenameContainer(ctx, s, "app", "new-app") },
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			defer cancel()
			if err := run(ctx); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("请求超时后 Docker 调用没有结束", err)
			}
		})
	}
}
