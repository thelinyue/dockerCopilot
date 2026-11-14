package utiles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func UpdateContainer(s *svc.ServiceContext, id, name, imageRef string, deleteOld bool, taskID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	old, err := s.DockerClient.ContainerInspect(ctx, id)
	if err != nil {
		return err
	}
	if err := CanRecreate(old); err != nil {
		return err
	}
	if old.Config.Labels["com.docker.compose.project"] != "" {
		return fmt.Errorf("此容器属于项目，请在项目页面更新整个服务")
	}
	if strings.Contains(strings.ToLower(old.Config.Image), "dockercopilot") || strings.Contains(strings.ToLower(old.Name), "dockercopilot") {
		return fmt.Errorf("请使用程序更新入口或在宿主机升级 DockerCopilot 镜像")
	}
	if !old.State.Running {
		return fmt.Errorf("容器已停止，请先启动后再更新")
	}
	if strings.TrimSpace(imageRef) == "" {
		imageRef = old.Config.Image
	}
	name = strings.TrimPrefix(old.Name, "/")
	progress := func(percent int, msg string) {
		p, _ := s.GetProgress(taskID)
		p.Percentage = percent
		p.Message = msg
		p.DetailMsg = msg
		s.UpdateProgress(taskID, p)
	}
	progress(5, "正在拉取镜像，旧容器继续运行")
	r, err := s.DockerClient.ImagePull(ctx, imageRef, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("拉取镜像失败，请检查宿主机 Docker 代理和仓库权限: %w", err)
	}
	err = decodePullResp(r, s, taskID)
	r.Close()
	if err != nil {
		return err
	}
	c, h, n, err := RecreateConfig(old, imageRef)
	if err != nil {
		return err
	}
	progress(35, "正在停止旧容器")
	if err := s.DockerClient.ContainerStop(ctx, id, container.StopOptions{Timeout: old.Config.StopTimeout}); err != nil {
		return err
	}
	newID := ""
	rollback := func(cause error) error {
		// 独立超时让更新超时后仍有机会恢复；只删除本次创建的容器，不删除数据卷。
		recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer recoveryCancel()
		var recoverErr error
		if newID != "" {
			recoverErr = s.DockerClient.ContainerRemove(recoveryCtx, newID, container.RemoveOptions{Force: true})
		}
		if recoverErr == nil {
			recoverErr = RestoreSnapshot(recoveryCtx, s, old)
		}
		p, _ := s.GetProgress(taskID)
		if recoverErr != nil {
			p.Status = "rollback_failed"
			s.UpdateProgress(taskID, p)
			return fmt.Errorf("更新失败，旧容器恢复失败，请人工处理: %v；恢复: %v", cause, recoverErr)
		}
		p.Status = "rolled_back"
		s.UpdateProgress(taskID, p)
		return fmt.Errorf("更新失败，已恢复旧容器: %v", cause)
	}
	if err := s.DockerClient.ContainerRename(ctx, id, name+"-old-"+taskID[:8]); err != nil {
		return rollback(err)
	}
	for networkName := range n.EndpointsConfig {
		if err := s.DockerClient.NetworkDisconnect(ctx, networkName, id, false); err != nil {
			return rollback(err)
		}
	}
	progress(55, "正在创建新容器")
	created, err := s.DockerClient.ContainerCreate(ctx, c, h, n, nil, name)
	if err != nil {
		return rollback(err)
	}
	newID = created.ID
	if err := s.DockerClient.ContainerStart(ctx, newID, container.StartOptions{}); err != nil {
		return rollback(err)
	}
	progress(80, "正在验证新容器运行状态")
	if err := WaitContainer(ctx, s, newID); err != nil {
		return rollback(err)
	}
	if deleteOld {
		if err := s.DockerClient.ContainerRemove(ctx, id, container.RemoveOptions{}); err != nil {
			return fmt.Errorf("新容器已通过验证，但旧容器清理失败，请手动清理: %w", err)
		}
	}
	s.HubImageInfo.Clear()
	progress(100, "更新成功")
	return nil
}

func decodePullResp(reader io.Reader, s *svc.ServiceContext, taskID string) error {
	decoder := json.NewDecoder(reader)
	for {
		var msg jsonmessage.JSONMessage
		err := decoder.Decode(&msg)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("读取镜像拉取结果失败: %w", err)
		}
		if msg.Error != nil {
			return fmt.Errorf("拉取镜像失败: %s", msg.Error.Message)
		}
		p, _ := s.GetProgress(taskID)
		p.DetailMsg = msg.Status
		s.UpdateProgress(taskID, p)
	}
}
