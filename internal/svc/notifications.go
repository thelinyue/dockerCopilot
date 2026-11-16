package svc

import (
	"context"
	"os"
	"strings"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/zeromicro/go-zero/core/logx"
)

type TaskNotification struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

func ContainerNotice(v docker.ContainerJSON) notify.Result {
	name := strings.TrimPrefix(v.Name, "/")
	result := notify.Result{ID: v.ID, Key: "container:" + name, Object: name, Replicas: 1}
	if v.Config != nil {
		result.Image = v.Config.Image
		if project, service := v.Config.Labels["com.docker.compose.project"], v.Config.Labels["com.docker.compose.service"]; project != "" && service != "" {
			result.Object = project + "/" + service
			result.Key = "service:" + result.Object
		}
	}
	return result
}

func (s *ServiceContext) RecordNotice(id string, result notify.Result) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ProgressStore[id]
	if result.ID == "" {
		result.ID = result.Key
	}
	results := make([]notify.Result, 0, len(p.NoticeResults)+1)
	for _, previous := range p.NoticeResults {
		if result.Kind == notify.UpdateSucceeded && previous.Kind == notify.Available && previous.Key == result.Key {
			continue
		}
		if previous.ID == result.ID && previous.Kind == result.Kind && previous.Image == result.Image {
			continue
		}
		results = append(results, previous)
	}
	p.NoticeResults = append(results, result)
	if s.ProgressStore == nil {
		s.ProgressStore = make(ProgressStoreType)
	}
	s.ProgressStore[id] = p
}

func (s *ServiceContext) ForgetAvailable(id, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ProgressStore[id]
	results := make([]notify.Result, 0, len(p.NoticeResults))
	for _, r := range p.NoticeResults {
		if r.Kind != notify.Available || r.Key != key {
			results = append(results, r)
		}
	}
	p.NoticeResults = results
	s.ProgressStore[id] = p
}

func (s *ServiceContext) NotificationDevice(ctx context.Context) string {
	name, _ := os.Hostname()
	if s.DockerClient != nil {
		infoCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if info, err := s.DockerClient.Info(infoCtx); err == nil && info.Name != "" {
			name = info.Name
		}
	}
	if name == "" {
		name = "当前设备"
	}
	return name
}

func (s *ServiceContext) finishNotification(id, action string) {
	if s.Settings == nil || (action != "check" && action != "auto-update" && action != "update") {
		return
	}
	settings := s.Settings.Get().Notifications
	if !settings.Enabled {
		s.setTaskNotification(id, nil)
		return
	}
	p, ok := s.GetProgress(id)
	if !ok {
		return
	}
	p.NoticeResults = notificationResults(p, action)
	message, send := notify.Format(settings, "", p.UpdatedAt, p.NoticeResults)
	if !send {
		s.setTaskNotification(id, nil)
		return
	}
	s.setTaskNotification(id, &TaskNotification{Status: "sending", Message: "正在发送 Bark 通知"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	message, _ = notify.Format(settings, s.NotificationDevice(ctx), p.UpdatedAt, p.NoticeResults)
	err := notify.SendBark(ctx, settings.Bark, message)
	status := TaskNotification{Status: "sent", Message: "Bark 已接受推送"}
	if err != nil {
		status = TaskNotification{Status: "failed", Message: err.Error()}
		logx.Errorf("任务 %s 的 Bark 通知发送失败：%s", id, err)
	}
	s.setTaskNotification(id, &status)
}

// 在任务标记完成之前放入发送状态，前端可继续轮询通知结果而不延长容器操作。
func (s *ServiceContext) prepareNotification(id, action string, p TaskProgress) {
	if s.Settings == nil || (action != "check" && action != "auto-update" && action != "update") {
		return
	}
	if _, send := notify.Format(s.Settings.Get().Notifications, "", p.UpdatedAt, notificationResults(p, action)); send {
		s.setTaskNotification(id, &TaskNotification{Status: "sending", Message: "正在发送 Bark 通知"})
	}
}

func notificationResults(p TaskProgress, action string) []notify.Result {
	// 捕获任务级中断；对象级错误已经记录时不重复增加一条笼统失败。
	if p.Status != "succeeded" {
		hasFailure := false
		for _, r := range p.NoticeResults {
			hasFailure = hasFailure || r.Kind == notify.CheckFailed || r.Kind == notify.UpdateFailed
		}
		if !hasFailure {
			kind := notify.CheckFailed
			if action == "update" {
				kind = notify.UpdateFailed
			}
			p.NoticeResults = append(append([]notify.Result{}, p.NoticeResults...), notify.Result{Key: "task", Object: p.Name, Kind: kind, Outcome: p.Status})
		}
	}
	return p.NoticeResults
}

func (s *ServiceContext) setTaskNotification(id string, notification *TaskNotification) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.ProgressStore[id]; ok {
		p.Notification = notification
		s.ProgressStore[id] = p
	}
}
