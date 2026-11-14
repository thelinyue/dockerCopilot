package utiles

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func CanRecreate(v docker.ContainerJSON) error {
	if v.Config == nil || v.HostConfig == nil || v.State == nil {
		return fmt.Errorf("容器运行配置不完整")
	}
	h := v.HostConfig
	if h.AutoRemove || len(h.VolumesFrom) > 0 || len(h.Links) > 0 || h.NetworkMode.IsContainer() || strings.HasPrefix(string(h.PidMode), "container:") || strings.HasPrefix(string(h.IpcMode), "container:") {
		return fmt.Errorf("容器使用自动删除、容器共享命名空间或旧式链接，无法可靠重建，请在宿主机管理")
	}
	return nil
}

// 只复制可持久配置。卷使用真实名称，不把匿名卷换成新卷；网络丢弃运行时端点 ID 和动态 IP。
func RecreateConfig(v docker.ContainerJSON, imageRef string) (*container.Config, *container.HostConfig, *network.NetworkingConfig, error) {
	if err := CanRecreate(v); err != nil {
		return nil, nil, nil, err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, nil, nil, err
	}
	var copy docker.ContainerJSON
	if err := json.Unmarshal(b, &copy); err != nil {
		return nil, nil, nil, err
	}
	c, h := copy.Config, copy.HostConfig
	c.Image = imageRef
	if len(v.ID) >= 12 && c.Hostname == v.ID[:12] {
		c.Hostname = ""
	}
	for _, actual := range v.Mounts {
		if actual.Type != mount.TypeVolume {
			continue
		}
		found := false
		for n := range h.Mounts {
			if h.Mounts[n].Target == actual.Destination {
				h.Mounts[n].Source = actual.Name
				found = true
			}
		}
		for n, bind := range h.Binds {
			parts := strings.Split(bind, ":")
			if len(parts) >= 2 && parts[1] == actual.Destination {
				parts[0] = actual.Name
				h.Binds[n] = strings.Join(parts, ":")
				found = true
			}
			if bind == actual.Destination {
				h.Binds[n] = actual.Name + ":" + actual.Destination
				found = true
			}
		}
		if !found {
			h.Mounts = append(h.Mounts, mount.Mount{Type: mount.TypeVolume, Source: actual.Name, Target: actual.Destination, ReadOnly: !actual.RW})
		}
	}
	if v.NetworkSettings != nil {
		h.PortBindings = v.NetworkSettings.Ports
		h.PublishAllPorts = false
	}
	n := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
	if v.NetworkSettings != nil && !h.NetworkMode.IsHost() && !h.NetworkMode.IsNone() {
		for name, ep := range v.NetworkSettings.Networks {
			aliases := []string{}
			for _, alias := range ep.Aliases {
				if alias != v.ID && (len(v.ID) < 12 || alias != v.ID[:12]) {
					aliases = append(aliases, alias)
				}
			}
			n.EndpointsConfig[name] = &network.EndpointSettings{IPAMConfig: ep.IPAMConfig, Aliases: aliases, Links: ep.Links, DriverOpts: ep.DriverOpts}
		}
	}
	return c, h, n, nil
}

func WaitContainer(ctx context.Context, s *svc.ServiceContext, id string) error {
	return waitContainer(ctx, s, id, 0)
}

// Compose 可能保留未变化的容器；历史重启次数不应被当成本次更新失败。
func WaitExistingContainer(ctx context.Context, s *svc.ServiceContext, id string, restartBaseline int) error {
	return waitContainer(ctx, s, id, restartBaseline)
}
func waitContainer(ctx context.Context, s *svc.ServiceContext, id string, restartBaseline int) error {
	deadline := time.NewTimer(120 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var runningSince time.Time
	for {
		v, err := s.DockerClient.ContainerInspect(ctx, id)
		if err != nil {
			return err
		}
		if v.State == nil || !v.State.Running || v.State.Restarting || v.RestartCount > restartBaseline {
			return fmt.Errorf("新容器退出或反复重启，请检查启动参数和日志")
		}
		if v.State.Health != nil {
			if v.State.Health.Status == "healthy" {
				return nil
			}
			if v.State.Health.Status == "unhealthy" {
				return fmt.Errorf("新容器健康检查未通过")
			}
		} else {
			if runningSince.IsZero() {
				runningSince = time.Now()
			}
			if time.Since(runningSince) >= 10*time.Second {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("等待容器健康超时（120 秒）")
		case <-tick.C:
		}
	}
}

func ReconnectSnapshot(ctx context.Context, s *svc.ServiceContext, old docker.ContainerJSON, id string) error {
	_, _, networks, err := RecreateConfig(old, old.Image)
	if err != nil {
		return err
	}
	current, err := s.DockerClient.ContainerInspect(ctx, id)
	if err != nil {
		return err
	}
	for name, ep := range networks.EndpointsConfig {
		if current.NetworkSettings != nil && current.NetworkSettings.Networks[name] != nil {
			continue
		}
		if err := s.DockerClient.NetworkConnect(ctx, name, id, ep); err != nil {
			return err
		}
	}
	return nil
}

func RestoreSnapshot(ctx context.Context, s *svc.ServiceContext, old docker.ContainerJSON) error {
	name := strings.TrimPrefix(old.Name, "/")
	if current, err := s.DockerClient.ContainerInspect(ctx, old.ID); err == nil {
		if current.Name != old.Name {
			if err := s.DockerClient.ContainerRename(ctx, old.ID, name); err != nil {
				return err
			}
		}
		if err := ReconnectSnapshot(ctx, s, old, old.ID); err != nil {
			return err
		}
		if old.State.Running {
			if err := s.DockerClient.ContainerStart(ctx, old.ID, container.StartOptions{}); err != nil {
				return err
			}
			return waitContainer(ctx, s, old.ID, old.RestartCount)
		}
		return nil
	}
	c, h, n, err := RecreateConfig(old, old.Image)
	if err != nil {
		return err
	}
	created, err := s.DockerClient.ContainerCreate(ctx, c, h, n, nil, name)
	if err != nil {
		return err
	}
	if old.State.Running {
		if err := s.DockerClient.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
			return err
		}
		return WaitContainer(ctx, s, created.ID)
	}
	return nil
}
