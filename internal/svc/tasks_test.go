package svc

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestTasksSerializeFailuresAndBoundRetention(t *testing.T) {
	s := &ServiceContext{}
	started, release := make(chan struct{}), make(chan struct{})
	id, err := s.RunTask("first", func(id string) error {
		close(started)
		<-release
		p, _ := s.GetProgress(id)
		p.Status = "rolled_back"
		s.UpdateProgress(id, p)
		return errors.New("更新失败，已恢复")
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, err := s.RunTask("overlap", func(string) error { t.Error("overlap executed"); return nil }); err == nil {
		t.Fatal("overlapping mutation accepted")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for {
		p, _ := s.GetProgress(id)
		if p.IsDone {
			if p.Status != "rolled_back" {
				t.Fatal(p)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("task not completed")
		}
		time.Sleep(time.Millisecond)
	}
	for i := 0; i < 240; i++ {
		s.UpdateProgress(fmt.Sprint(i), TaskProgress{IsDone: true, Percentage: 100})
	}
	if len(s.Tasks()) != 200 {
		t.Fatal("completed tasks not bounded", len(s.Tasks()))
	}
}
