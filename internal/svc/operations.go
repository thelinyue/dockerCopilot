package svc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	docker "github.com/docker/docker/api/types"
)

type TaskResource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type OperationScope struct {
	Resource *TaskResource
	Keys     []string
	Job      string
}

type BusyError struct{ Message string }

func (e *BusyError) Error() string { return e.Message }
func IsBusy(err error) bool {
	var busy *BusyError
	return errors.As(err, &busy)
}

func ProjectScope(name, directory string) OperationScope {
	id := base64.RawURLEncoding.EncodeToString([]byte(name + "\n" + directory))
	// Docker 以项目名识别对象，目录不同也不能绕过同名项目的互斥。
	return OperationScope{Resource: &TaskResource{Type: "project", ID: id, Name: name}, Keys: []string{"project:" + name}}
}

func ContainerScope(v docker.ContainerJSON) OperationScope {
	if name := v.Config.Labels["com.docker.compose.project"]; name != "" {
		return ProjectScope(name, v.Config.Labels["com.docker.compose.project.working_dir"])
	}
	name := strings.TrimPrefix(v.Name, "/")
	// ID 保护被改名的旧容器，名称保护替换后尚在验证的新容器。
	return OperationScope{Resource: &TaskResource{Type: "container", ID: v.ID, Name: name}, Keys: []string{"container-id:" + v.ID, "container-name:" + name}}
}

// 普通对象共享节点读锁；删除镜像、清理和程序升级独占节点写锁。
// 网络和 Docker 调用均不持有 operationMu，其他对象只需经过短临界区。
func (s *ServiceContext) Acquire(scope OperationScope) (func(), error) {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	if s.restarting {
		return nil, &BusyError{"DockerCopilot 即将重启，请稍后重新连接"}
	}
	if scope.Job == "" && len(scope.Keys) == 0 {
		if !s.Operation.TryLock() {
			return nil, &BusyError{"本设备有正在执行的变更，请完成后重试此节点级操作"}
		}
		return onceRelease(s.Operation.Unlock), nil
	}
	keys := scope.Keys
	if scope.Job != "" {
		keys = []string{"job:" + scope.Job}
	} else if !s.Operation.TryRLock() {
		return nil, &BusyError{"本设备正在清理镜像或升级程序，请稍后重试"}
	}
	for _, key := range keys {
		if s.operationKeys[key] {
			if scope.Job == "" {
				s.Operation.RUnlock()
			}
			name := "此对象"
			if scope.Resource != nil {
				name = scope.Resource.Name
			} else if scope.Job != "" {
				name = "同类任务"
			}
			return nil, &BusyError{fmt.Sprintf("%s 正在执行操作，请等待完成后重试", name)}
		}
	}
	if s.operationKeys == nil {
		s.operationKeys = map[string]bool{}
	}
	for _, key := range keys {
		s.operationKeys[key] = true
	}
	return onceRelease(func() {
		s.operationMu.Lock()
		for _, key := range keys {
			delete(s.operationKeys, key)
		}
		s.operationMu.Unlock()
		if scope.Job == "" {
			s.Operation.RUnlock()
		}
	}), nil
}

func onceRelease(fn func()) func() {
	var once sync.Once
	return func() { once.Do(fn) }
}

func (s *ServiceContext) SetRestarting() {
	s.operationMu.Lock()
	s.restarting = true
	s.operationMu.Unlock()
}

func (s *ServiceContext) VerifyContainer(ctx context.Context, before docker.ContainerJSON) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	after, err := s.DockerClient.ContainerInspect(ctx, before.ID)
	if err != nil {
		return fmt.Errorf("容器已变化或无法读取，请刷新后重试: %w", err)
	}
	if after.Config == nil || after.Name != before.Name || *ContainerScope(after).Resource != *ContainerScope(before).Resource {
		return &BusyError{"容器名称或项目归属已变化，请刷新后重试"}
	}
	return nil
}

func (s *ServiceContext) AcquireContainer(ctx context.Context, id, newName string) (docker.ContainerJSON, func(), error) {
	v, err := s.DockerClient.ContainerInspect(ctx, id)
	if err != nil {
		return v, nil, fmt.Errorf("无法读取容器，请刷新列表后重试: %w", err)
	}
	if v.Config == nil {
		return v, nil, fmt.Errorf("容器配置不完整，请检查 Docker 状态")
	}
	scope := ContainerScope(v)
	if newName != "" {
		scope.Keys = append(scope.Keys, "container-name:"+strings.TrimPrefix(newName, "/"))
	}
	release, err := s.Acquire(scope)
	if err != nil {
		return v, nil, err
	}
	if err := s.VerifyContainer(ctx, v); err != nil {
		release()
		return v, nil, err
	}
	return v, release, nil
}
