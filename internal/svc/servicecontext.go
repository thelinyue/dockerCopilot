package svc

import (
	"fmt"
	"github.com/docker/docker/client"
	"github.com/google/uuid"
	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
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
	Operation                  sync.Mutex
	mu                         sync.Mutex
}

type TaskProgress struct {
	TaskID     string    `json:"taskID"`
	Percentage int       `json:"percentage"`
	Message    string    `json:"message"`
	Name       string    `json:"name"`
	DetailMsg  string    `json:"detailMsg"`
	IsDone     bool      `json:"isDone"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
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

// 取得操作锁后再返回任务 ID，保证定时和手动变更不会重复操作同一 Docker 节点。
func (ctx *ServiceContext) RunTask(name string, fn func(string) error) (string, error) {
	if !ctx.Operation.TryLock() {
		return "", fmt.Errorf("本设备正在执行变更，请等待当前任务完成")
	}
	id := uuid.NewString()
	ctx.UpdateProgress(id, TaskProgress{Name: name, Message: "任务已开始", Status: "running"})
	go func() {
		defer ctx.Operation.Unlock()
		defer func() {
			if recover() != nil {
				p, _ := ctx.GetProgress(id)
				p.IsDone = true
				p.Status = "failed"
				p.Message = "任务异常中断，请检查设备运行状态"
				ctx.UpdateProgress(id, p)
			}
		}()
		err := fn(id)
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
		}
		ctx.UpdateProgress(id, p)
		if err != nil {
			logx.Errorf("任务 %s 失败: %s", id, err)
		}
	}()
	return id, nil
}
