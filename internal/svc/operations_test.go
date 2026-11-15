package svc

import (
	"context"
	"errors"
	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"testing"
	"time"
)

func TestDifferentObjectsCanRunTogether(t *testing.T) {
	s := &ServiceContext{}
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	_, err := s.RunTask("项目 A", ProjectScope("a", "/a"), "update", func(string) error {
		close(started)
		<-release
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	done := make(chan struct{})
	_, err = s.RunTask("项目 B", ProjectScope("b", "/b"), "stop", func(string) error { close(done); return nil })
	if err != nil {
		t.Fatalf("项目 A 不应阻塞项目 B: %v", err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("项目 B 等待了项目 A")
	}
}

func TestResourceAliasesJobsAndExclusiveOperations(t *testing.T) {
	s := &ServiceContext{}
	old := docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: "old-id", Name: "/app"}, Config: &container.Config{}}
	release, err := s.Acquire(ContainerScope(old))
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range []docker.ContainerJSON{
		{ContainerJSONBase: &docker.ContainerJSONBase{ID: "new-id", Name: "/app"}, Config: &container.Config{}},
		{ContainerJSONBase: &docker.ContainerJSONBase{ID: "old-id", Name: "/app-old"}, Config: &container.Config{}},
	} {
		if done, err := s.Acquire(ContainerScope(other)); err == nil {
			done()
			t.Fatal("更新的新旧身份绕过互斥")
		}
	}
	if done, err := s.Acquire(OperationScope{}); err == nil {
		done()
		t.Fatal("变更期间允许节点独占")
	}
	check, err := s.Acquire(OperationScope{Job: "check"})
	if err != nil {
		t.Fatal("检测阻塞了对象变更", err)
	}
	if _, err := s.Acquire(OperationScope{Job: "check"}); !IsBusy(err) {
		t.Fatal("重复检测未被拒绝", err)
	}
	check()
	release()
	release() // 失败清理和任务退出可能走到同一个释放函数。
	project, err := s.Acquire(ProjectScope("same", "/first"))
	if err != nil {
		t.Fatal(err)
	}
	labeled := old
	labeled.Config = &container.Config{Labels: map[string]string{"com.docker.compose.project": "same", "com.docker.compose.project.working_dir": "/second"}}
	if _, err := s.Acquire(ContainerScope(labeled)); !IsBusy(err) {
		t.Fatal("所属容器或不同目录同名项目绕过项目锁", err)
	}
	project()
	exclusive, err := s.Acquire(OperationScope{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Acquire(ProjectScope("other", "/other")); !IsBusy(err) {
		t.Fatal("节点独占期间接受了变更", err)
	}
	s.SetRestarting()
	exclusive()
	if _, err := s.Acquire(ProjectScope("other", "/other")); !IsBusy(err) {
		t.Fatal("安全退出期间接受了变更", err)
	}
}

func TestTaskFailureAndPanicReleaseOnlyTheirResource(t *testing.T) {
	for _, panicTask := range []bool{false, true} {
		s := &ServiceContext{}
		id, err := s.RunTask("失败任务", ProjectScope("app", "/app"), "update", func(string) error {
			if panicTask {
				panic("fixture")
			}
			return context.DeadlineExceeded
		})
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(time.Second)
		for {
			p, _ := s.GetProgress(id)
			if p.IsDone {
				if p.Status != "failed" || p.Resource.Name != "app" || p.Action != "update" {
					t.Fatal(p)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("任务没有结束")
			}
			time.Sleep(time.Millisecond)
		}
		// panic 的完成状态和 defer 释放之间可能有极短间隔，允许重试获取。
		for {
			release, err := s.Acquire(ProjectScope("app", "/app"))
			if err == nil {
				release()
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("失败后资源未释放", err)
			}
			time.Sleep(time.Millisecond)
		}
		if IsBusy(errors.New("fixture")) {
			t.Fatal("普通错误被当作冲突")
		}
	}
}
