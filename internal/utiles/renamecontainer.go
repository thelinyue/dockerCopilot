package utiles

import (
	"context"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"time"
)

func RenameContainer(ctx context.Context, s *svc.ServiceContext, id string, newName string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	err := s.DockerClient.ContainerRename(ctx, id, newName)
	if err != nil {
		return err
	}
	return nil
}
