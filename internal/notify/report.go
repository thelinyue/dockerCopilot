package notify

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

const (
	Available       = "available"
	CheckFailed     = "check_failed"
	UpdateSucceeded = "update_succeeded"
	UpdateFailed    = "update_failed"
)

// Key 表示容器名称或项目服务，ID 区分副本与检测目标；容器替换后仍可移除同一服务的待更新提示。
type Result struct {
	ID       string
	Key      string
	Object   string
	Image    string
	Replicas int
	Kind     string
	Outcome  string
}

func (r Result) enabled(n node.NotificationSettings) bool {
	switch r.Kind {
	case Available:
		return n.UpdateAvailable
	case CheckFailed:
		return n.CheckFailed
	case UpdateSucceeded:
		return n.UpdateSucceeded
	case UpdateFailed:
		return n.UpdateFailed
	}
	return false
}

func (r Result) label(mixed bool) string {
	switch r.Kind {
	case Available:
		return "发现镜像更新"
	case CheckFailed:
		return "检查异常"
	case UpdateSucceeded:
		if mixed {
			return "成功"
		}
		return "更新成功"
	case UpdateFailed:
		if mixed {
			return "失败"
		}
		return "更新失败"
	}
	return ""
}

func Clip(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	end := limit - len("…")
	if end < 0 {
		return ""
	}
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…"
}

func Format(settings node.NotificationSettings, device string, at time.Time, results []Result) (Message, bool) {
	if !settings.Enabled {
		return Message{}, false
	}
	groups := map[string]Result{}
	for _, r := range results {
		if !r.enabled(settings) {
			continue
		}
		key := r.Key + "\n" + r.Kind + "\n" + r.Outcome
		previous := groups[key]
		if r.Image == "" {
			r.Image = previous.Image
		} else if previous.Image != "" && !node.Contains(strings.Split(previous.Image, "、"), r.Image) {
			r.Image = previous.Image + "、" + r.Image
		} else if previous.Image != "" {
			r.Image = previous.Image
		}
		if r.Replicas < 1 {
			r.Replicas = 1
		}
		r.Replicas += previous.Replicas
		groups[key] = r
	}
	if len(groups) == 0 {
		return Message{}, false
	}
	items := make([]Result, 0, len(groups))
	counts := map[string]int{}
	for _, r := range groups {
		items = append(items, r)
		counts[r.Kind]++
	}
	rank := map[string]int{UpdateFailed: 0, CheckFailed: 1, UpdateSucceeded: 2, Available: 3}
	sort.Slice(items, func(i, j int) bool {
		if rank[items[i].Kind] != rank[items[j].Kind] {
			return rank[items[i].Kind] < rank[items[j].Kind]
		}
		return items[i].Object+items[i].Image < items[j].Object+items[j].Image
	})
	mixed := len(counts) > 1
	summary := []string{}
	for _, kind := range []string{UpdateSucceeded, UpdateFailed, CheckFailed, Available} {
		if counts[kind] > 0 {
			text := fmt.Sprintf("%s %d", (Result{Kind: kind}).label(mixed), counts[kind])
			if !mixed {
				text += " 项"
			}
			summary = append(summary, text)
		}
	}
	body := Clip(device, 120) + " · " + at.Format("01-02 15:04")
	footerBudget := len(fmt.Sprintf("\n另有 %d 项，详见执行记录", len(items)))
	for i, r := range items {
		line := "\n"
		// 单类结果由标题说明状态；混合结果逐项标注，避免手机预览重复堆字。
		if mixed {
			line += r.label(true) + "："
		}
		line += Clip(r.Object, 150)
		if r.Replicas > 1 {
			line += fmt.Sprintf("（%d 副本）", r.Replicas)
		}
		if r.Image != "" {
			line += " · " + Clip(r.Image, 150)
		}
		if r.Kind == UpdateFailed {
			switch r.Outcome {
			case "rolled_back":
				line += " · 已恢复"
			case "rollback_failed":
				line += " · 恢复失败，需处理"
			}
		}
		// 预留省略说明的空间，保证中文与 emoji 完整，APNs 包体仍有足够余量。
		if len(body)+len(line) > 2048-footerBudget {
			body += fmt.Sprintf("\n另有 %d 项，详见执行记录", len(items)-i)
			break
		}
		body += line
	}
	return Message{Title: Clip("DockerCopilot · "+strings.Join(summary, " · "), 180), Body: body}, true
}
