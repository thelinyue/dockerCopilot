package svc

import (
	"fmt"
	"github.com/docker/docker/client"
	"github.com/google/uuid"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/rest"
	"sort"
	"sync"
	"time"
)

type ServiceContext struct {
	Config                     config.Config
	CookieCheckMiddleware      rest.Middleware
	Jwtuuid                    string
	BearerTokenCheckMiddleware rest.Middleware
	JwtSecret                  string
	PortainerJwt               string
	HubImageInfo               *module.ImageUpdateData
	IndexCheckMiddleware       rest.Middleware
	ProgressStore              ProgressStoreType
	DockerClient               *client.Client
	Settings                   *node.Store
	Devices                    *node.Devices
	Operation                  sync.RWMutex
	operationMu                sync.Mutex
	operationKeys              map[string]bool
	restarting                 bool
	mu                         sync.Mutex
}

type TaskProgress struct {
	TaskID        string            `json:"taskID"`
	Percentage    int               `json:"percentage"`
	Message       string            `json:"message"`
	Name          string            `json:"name"`
	DetailMsg     string            `json:"detailMsg"`
	IsDone        bool              `json:"isDone"`
	Status        string            `json:"status"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
	Resource      *TaskResource     `json:"resource,omitempty"`
	Action        string            `json:"action,omitempty"`
	Cleanup       string            `json:"cleanup,omitempty"`
	OldImages     []string          `json:"-"`
	Notification  *TaskNotification `json:"notification,omitempty"`
	NoticeResults []notify.Result   `json:"-"`
}

type ProgressStoreType map[string]TaskProgress

func NewServiceContext(c config.Config) *ServiceContext {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		panic(fmt.Errorf("无法创建 Docker 客户端: %w", err))
	}
	settings, err := node.OpenSettings(node.DataDir())
	if err != nil {
		panic(err)
	}
	devices, err := node.OpenDevices(node.DataDir())
	if err != nil {
		panic(err)
	}
	return &ServiceContext{
		Config:        c,
		HubImageInfo:  module.NewImageCheck(),
		ProgressStore: make(ProgressStoreType),
		DockerClient:  cli,
		Settings:      settings,
		Devices:       devices,
	}
}

func (ctx *ServiceContext) UpdateProgress(taskID string, progress TaskProgress) {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	if ctx.ProgressStore == nil {
		ctx.ProgressStore = make(ProgressStoreType)
	}
	previous := ctx.ProgressStore[taskID]
	progress.NoticeResults = previous.NoticeResults
	progress.Notification = previous.Notification
	progress.TaskID = taskID
	if progress.CreatedAt.IsZero() {
		progress.CreatedAt = previous.CreatedAt
		if progress.CreatedAt.IsZero() {
			progress.CreatedAt = time.Now()
		}
	}
	progress.UpdatedAt = time.Now()
	if progress.Status == "" {
		progress.Status = "running"
		if progress.IsDone {
			if progress.Percentage == 100 {
				progress.Status = "succeeded"
			} else {
				progress.Status = "failed"
			}
		}
	}
	ctx.ProgressStore[taskID] = progress
	if len(ctx.ProgressStore) > 200 {
		var oldest string
		for id, p := range ctx.ProgressStore {
			if p.IsDone && (oldest == "" || p.UpdatedAt.Before(ctx.ProgressStore[oldest].UpdatedAt)) {
				oldest = id
			}
		}
		if oldest != "" {
			delete(ctx.ProgressStore, oldest)
		}
	}
}

func (ctx *ServiceContext) GetProgress(taskID string) (TaskProgress, bool) {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	progress, ok := ctx.ProgressStore[taskID]
	return progress, ok
}

func (ctx *ServiceContext) Tasks() []TaskProgress {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	items := make([]TaskProgress, 0, len(ctx.ProgressStore))
	for _, p := range ctx.ProgressStore {
		items = append(items, p)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items
}

// 先预留对象，再返回任务 ID；切页或请求断开不会释放后台任务的操作锁。
func (ctx *ServiceContext) RunTask(name string, scope OperationScope, action string, fn func(string) error) (string, error) {
	release, err := ctx.Acquire(scope)
	if err != nil {
		return "", err
	}
	id := uuid.NewString()
	ctx.UpdateProgress(id, TaskProgress{Name: name, Message: "任务已开始", Status: "running", Resource: scope.Resource, Action: action})
	go func() {
		defer release()
		defer func() {
			if recover() != nil {
				release()
				p, _ := ctx.GetProgress(id)
				p.IsDone = true
				p.Status = "failed"
				p.Message = "任务异常中断，请检查设备运行状态"
				ctx.prepareNotification(id, action, p)
				ctx.UpdateProgress(id, p)
				ctx.finishNotification(id, action)
			}
		}()
		err := fn(id)
		// 清理镜像需节点独占，先结束对象变更；其他对象忙碌时只跳过清理。
		release()
		ctx.CleanupTaskImages(id)
		p, _ := ctx.GetProgress(id)
		p.IsDone = true
		if err != nil {
			if p.Status != "rolled_back" && p.Status != "rollback_failed" {
				p.Status = "failed"
			}
			p.Message = err.Error()
		} else {
			p.Status = "succeeded"
			p.Percentage = 100
			p.Message = "任务完成"
			if p.Cleanup != "" {
				p.Message += "；" + p.Cleanup
			}
		}
		ctx.prepareNotification(id, action, p)
		ctx.UpdateProgress(id, p)
		if err != nil {
			logx.Errorf("任务 %s 失败: %s", id, err)
		}
		ctx.finishNotification(id, action)
	}()
	return id, nil
}

func (ctx *ServiceContext) TaskResource(id string, resource *TaskResource, action string) {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	p := ctx.ProgressStore[id]
	p.Resource, p.Action = resource, action
	ctx.ProgressStore[id] = p
}
