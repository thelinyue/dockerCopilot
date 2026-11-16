package management

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/errdefs"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/robfig/cron/v3"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/rest/token"
)

type Manager struct {
	Context      *svc.ServiceContext
	mu           sync.Mutex
	cron         *cron.Cron
	scheduleJob  cron.EntryID
	scheduleCron string
	parser       *token.TokenParser
}

func New(s *svc.ServiceContext) *Manager {
	return &Manager{Context: s, cron: cron.New(cron.WithParser(node.CronParser)), parser: token.NewTokenParser()}
}
func (m *Manager) Start() {
	m.ReloadSchedules()
	m.cron.Start()
	if m.Context.Settings.Get().StartupCheck {
		m.launch("启动检测", "check", m.Check)
	}
}
func (m *Manager) Stop() { <-m.cron.Stop().Done() }
func (m *Manager) launch(name, job string, fn func(context.Context, string) error) {
	_, err := m.Context.RunTask(name, svc.OperationScope{Job: "automation"}, job, func(id string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
		defer cancel()
		return fn(ctx, id)
	})
	if err != nil {
		logx.Infof("%s 已跳过：%s", name, err)
	}
}
func (m *Manager) ReloadSchedules() {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.Context.Settings.Get()
	if m.scheduleJob != 0 && m.scheduleCron == s.ScheduleCron() {
		return
	}
	m.cron.Remove(m.scheduleJob)
	m.scheduleJob, _ = m.cron.AddFunc(s.ScheduleCron(), func() {
		// 模式在触发时读取，切换自动更新不改变下一次执行时间。
		if m.Context.Settings.Get().AutoUpdate {
			m.launch("定时检测并更新", "auto-update", m.AutoUpdate)
		} else {
			m.launch("定时检测", "check", m.Check)
		}
	})
	m.scheduleCron = s.ScheduleCron()
}
func (m *Manager) NextRuns() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.cron.Entry(m.scheduleJob).Next
	var update time.Time
	if m.Context.Settings.Get().AutoUpdate {
		update = next
	}
	// schedule 同时表明当前节点采用统一调度；旧界面仍可读取 check/update。
	return map[string]any{"schedule": next, "check": next, "update": update, "timezone": time.Local.String()}
}
func (m *Manager) message(id string, percent int, text string) {
	p, _ := m.Context.GetProgress(id)
	p.Percentage = percent
	p.Message = text
	m.Context.UpdateProgress(id, p)
}

func isCopilot(v docker.ContainerJSON) bool {
	if v.Config == nil {
		return true
	}
	hostname, _ := os.Hostname()
	return (len(hostname) >= 12 && strings.HasPrefix(v.ID, hostname)) || strings.Contains(strings.ToLower(v.Config.Image), "dockercopilot") || strings.Contains(strings.ToLower(v.Name), "dockercopilot")
}

type checkRun struct {
	images     map[string]module.ImageCheckList
	containers map[string]docker.ContainerJSON
	total      int
	available  int
	failed     int
}

func newCheckRun() *checkRun {
	return &checkRun{images: map[string]module.ImageCheckList{}, containers: map[string]docker.ContainerJSON{}}
}

func (r *checkRun) summary() string {
	return fmt.Sprintf("检测 %d 个容器，可更新 %d 个，无法确认 %d 个；具体原因见容器列表", r.total, r.available, r.failed)
}

func sameCheckContainer(before, after docker.ContainerJSON) bool {
	return before.ContainerJSONBase != nil && after.ContainerJSONBase != nil && before.ID == after.ID &&
		after.Image == before.Image && after.Name == before.Name && before.Config != nil && after.Config != nil && after.Config.Image == before.Config.Image
}

func (r *checkRun) unchanged(v docker.ContainerJSON) bool {
	before, ok := r.containers[v.ID]
	return ok && sameCheckContainer(before, v) && before.State != nil && v.State != nil && before.State.Running == v.State.Running
}

func (m *Manager) checkContainer(ctx context.Context, v docker.ContainerJSON, imageRef string, run *checkRun) (module.ImageCheckList, bool) {
	// 本地镜像 ID 唯一对应其平台配置；仅复用本次任务内相同引用、镜像和平台的结果。
	key := imageRef + "\n" + v.Image
	result, ok := run.images[key]
	if !ok {
		result.CheckedAt = time.Now()
		local, _, err := m.Context.DockerClient.ImageInspectWithRaw(ctx, v.Image)
		if err == nil {
			client := module.ProxyClient(m.Context.Settings.Get())
			defer client.CloseIdleConnections()
			result.NeedUpdate, err = module.CheckReference(ctx, client, imageRef, v.Image, local.Os, local.Architecture, local.Variant)
		}
		if err != nil {
			result.Error = err.Error()
		}
		run.images[key] = result
	}
	if imageRef == v.Config.Image {
		return result, m.storeCheck(ctx, v, result)
	}
	// 已保存 Compose 的目标可能不同于当前容器，不能把目标检测冒充当前镜像的列表提示。
	after, err := m.Context.DockerClient.ContainerInspect(ctx, v.ID)
	return result, err == nil && sameCheckContainer(v, after)
}

func (m *Manager) storeCheck(ctx context.Context, before docker.ContainerJSON, result module.ImageCheckList) bool {
	// 检测不锁住对象；网络返回后确认仍是同一镜像，避免把替换前结果写回。
	after, err := m.Context.DockerClient.ContainerInspect(ctx, before.ID)
	if err == nil && sameCheckContainer(before, after) {
		m.Context.HubImageInfo.Set(before.ID, result)
		return true
	}
	return false
}

func (m *Manager) Check(ctx context.Context, id string) error {
	run := newCheckRun()
	if err := m.checkAll(ctx, id, run, 100); err != nil {
		return err
	}
	if run.failed > 0 {
		return fmt.Errorf("检测完成，%d 个容器无法确认更新，请查看容器列表中的原因", run.failed)
	}
	return nil
}

func (m *Manager) checkAll(ctx context.Context, id string, run *checkRun, progressEnd int) error {
	list, err := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return fmt.Errorf("连接 Docker 失败，请检查 socket 挂载: %w", err)
	}
	ids := make([]string, 0, len(list))
	for _, c := range list {
		ids = append(ids, c.ID)
	}
	m.Context.HubImageInfo.Retain(ids)
	run.total = len(list)
	for i, c := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		v, err := m.Context.DockerClient.ContainerInspect(ctx, c.ID)
		if err != nil {
			if !errdefs.IsNotFound(err) {
				run.failed++
				notice := svc.ContainerNotice(docker.ContainerJSON{ContainerJSONBase: &docker.ContainerJSONBase{ID: c.ID, Name: firstContainerName(c.Names, c.ID)}, Config: &container.Config{Image: c.Image, Labels: c.Labels}})
				notice.Kind = notify.CheckFailed
				m.Context.RecordNotice(id, notice)
			}
			continue
		}
		if v.Config == nil {
			run.failed++
			m.Context.RecordNotice(id, notify.Result{ID: c.ID, Key: "container:" + c.ID, Object: strings.TrimPrefix(v.Name, "/"), Kind: notify.CheckFailed})
			continue
		}
		result, current := m.checkContainer(ctx, v, v.Config.Image, run)
		if !current {
			continue
		}
		run.containers[v.ID] = v
		notice := svc.ContainerNotice(v)
		if result.Error != "" {
			run.failed++
			notice.Kind = notify.CheckFailed
		}
		if result.NeedUpdate {
			run.available++
			notice.Kind = notify.Available
		}
		if notice.Kind != "" {
			m.Context.RecordNotice(id, notice)
		}
		m.message(id, (i+1)*progressEnd/len(list), fmt.Sprintf("已检测 %d/%d 个容器，可更新 %d 个，无法确认 %d 个", i+1, len(list), run.available, run.failed))
	}
	p, _ := m.Context.GetProgress(id)
	p.DetailMsg = run.summary()
	m.Context.UpdateProgress(id, p)
	return nil
}

func firstContainerName(names []string, fallback string) string {
	if len(names) > 0 {
		return names[0]
	}
	return fallback
}

func excluded(s node.Settings, v docker.ContainerJSON) bool {
	return node.Contains(s.ExcludedContainers, v.ID) || node.Contains(s.ExcludedContainers, strings.TrimPrefix(v.Name, "/"))
}
