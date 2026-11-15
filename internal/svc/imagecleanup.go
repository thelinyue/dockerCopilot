package svc

import (
	"context"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/errdefs"
)

func (s *ServiceContext) ScheduleImageCleanup(taskID string, ids ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ProgressStore[taskID]
	p.OldImages = append(append([]string{}, p.OldImages...), ids...)
	s.ProgressStore[taskID] = p
}

// 仅清理本次更新留下、无标签且无容器引用的旧镜像，绝不全局 prune 或强制删除。
func (s *ServiceContext) CleanupTaskImages(taskID string) {
	p, _ := s.GetProgress(taskID)
	if len(p.OldImages) == 0 {
		return
	}
	result := ""
	if !s.Operation.TryLock() {
		result = "旧镜像清理已跳过：其他对象正在操作"
	} else {
		func() {
			defer s.Operation.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			containers, err := s.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
			if err != nil {
				result = "旧镜像清理未完成：无法确认容器引用，请稍后检查镜像页"
				return
			}
			used := map[string]bool{}
			for _, c := range containers {
				used[c.ImageID] = true
			}
			seen := map[string]bool{}
			removed, kept, failed := 0, 0, 0
			for _, id := range p.OldImages {
				if id == "" || seen[id] {
					continue
				}
				seen[id] = true
				if used[id] {
					kept++
					continue
				}
				v, _, err := s.DockerClient.ImageInspectWithRaw(ctx, id)
				if err != nil {
					if !errdefs.IsNotFound(err) {
						failed++
					}
					continue
				}
				tagged := false
				for _, tag := range v.RepoTags {
					if tag != "<none>:<none>" && tag != "" {
						tagged = true
					}
				}
				if tagged {
					kept++
					continue
				}
				if _, err := s.DockerClient.ImageRemove(ctx, id, image.RemoveOptions{Force: false, PruneChildren: false}); err != nil {
					failed++
				} else {
					removed++
				}
			}
			result = fmt.Sprintf("旧镜像清理：删除 %d 个，保留 %d 个", removed, kept)
			if failed > 0 {
				result += fmt.Sprintf("，%d 个未完成，请在镜像页检查", failed)
			}
		}()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p = s.ProgressStore[taskID]
	p.OldImages = nil
	if p.Cleanup != "" {
		p.Cleanup += "\n"
	}
	p.Cleanup += result
	s.ProgressStore[taskID] = p
}
