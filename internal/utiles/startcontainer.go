package utiles

import (
	"context"
	"github.com/docker/docker/api/types/container"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"time"
)

func StartContainer(ctx context.Context, s *svc.ServiceContext, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	startOptions := container.StartOptions{}
	err := s.DockerClient.ContainerStart(ctx, id, startOptions)
	if err != nil {
		return err
	}

	return nil
}
