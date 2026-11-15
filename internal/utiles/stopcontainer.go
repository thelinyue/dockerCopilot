package utiles

import (
	"context"
	"github.com/docker/docker/api/types/container"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"time"
)

func StopContainer(ctx context.Context, s *svc.ServiceContext, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	timeout := 10
	signal := "SIGINT"
	stopOptions := container.StopOptions{
		Signal:  signal,
		Timeout: &timeout,
	}
	err := s.DockerClient.ContainerStop(ctx, id, stopOptions)
	if err != nil {
		return err
	}
	return nil
}
