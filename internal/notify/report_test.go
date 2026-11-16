package notify

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

func TestReportEventSwitchesAndQuietLatest(t *testing.T) {
	n := node.DefaultNotifications()
	n.Enabled = true
	results := []Result{{Key: "a", Object: "available", Kind: Available}, {Key: "c", Object: "check-error", Kind: CheckFailed}, {Key: "s", Object: "success", Kind: UpdateSucceeded}, {Key: "f", Object: "rollback", Kind: UpdateFailed, Outcome: "rolled_back"}}
	for mask := 0; mask < 16; mask++ {
		n.UpdateAvailable, n.CheckFailed, n.UpdateSucceeded, n.UpdateFailed = mask&1 != 0, mask&2 != 0, mask&4 != 0, mask&8 != 0
		message, send := Format(n, "NAS", time.Now(), results)
		if send != (mask != 0) {
			t.Fatal(mask, send)
		}
		for i, name := range []string{"available", "check-error", "success", "rollback"} {
			if strings.Contains(message.Body, name) != (mask&(1<<i) != 0) {
				t.Fatal(mask, name, message)
			}
		}
	}
	n = node.DefaultNotifications()
	if _, send := Format(n, "NAS", time.Now(), results); send {
		t.Fatal("总开关关闭仍发送")
	}
	n.Enabled = true
	if _, send := Format(n, "NAS", time.Now(), nil); send {
		t.Fatal("全部最新仍发送")
	}
}

func TestReportReplicasAndUTF8LimitPrioritizesFailures(t *testing.T) {
	n := node.DefaultNotifications()
	n.Enabled = true
	results := []Result{{Key: "service:media/web", Object: "media/web", Image: "example/web:latest", Kind: Available, Replicas: 1}, {Key: "service:media/web", Object: "media/web", Image: "example/web:latest", Kind: Available, Replicas: 1}}
	m, _ := Format(n, "NAS", time.Now(), results)
	if m.Title != "DockerCopilot · 发现镜像更新 1 项" || strings.Count(m.Body, "media/web") != 1 || !strings.Contains(m.Body, "media/web（2 副本） · example/web:latest") || strings.Contains(m.Body, "发现镜像更新") {
		t.Fatal(m)
	}
	results[1].Image = "example/web:stable"
	m, _ = Format(n, "NAS", time.Now(), results)
	if strings.Count(m.Body, "media/web") != 1 || !strings.Contains(m.Body, "2 副本") || !strings.Contains(m.Body, "example/web:stable") {
		t.Fatal("不同镜像引用的副本未合并", m)
	}
	for i := 0; i < 100; i++ {
		results = append(results, Result{Key: fmt.Sprint(i), Object: strings.Repeat("容器🚀", 30) + fmt.Sprint(i), Kind: Available})
	}
	results = append(results, Result{Key: "failed", Object: "故障服务", Kind: UpdateFailed, Outcome: "rollback_failed"})
	m, _ = Format(n, strings.Repeat("设备🚀", 100), time.Now(), results)
	if len(m.Body) > 2048 || !utf8.ValidString(m.Body) || !utf8.ValidString(m.Title) || !strings.Contains(m.Body, "项，详见执行记录") || !strings.Contains(m.Body, "故障服务") || strings.Index(m.Body, "故障服务") > strings.Index(m.Body, "容器🚀") {
		t.Fatal(len(m.Body), m)
	}
}

func TestCompactReportKeepsRecoveryDetailsAndLabelsOnlyMixedResults(t *testing.T) {
	n := node.DefaultNotifications()
	n.Enabled = true
	results := []Result{
		{Key: "nginx", Object: "nginx", Image: "nginx:latest", Kind: UpdateSucceeded},
		{Key: "redis", Object: "redis", Image: "redis:7", Kind: UpdateFailed, Outcome: "rolled_back"},
		{Key: "db", Object: "db", Image: "postgres:16", Kind: UpdateFailed, Outcome: "rollback_failed"},
		{Key: "web", Object: "web", Image: "example/web:latest", Kind: CheckFailed},
	}
	at := time.Date(2026, 11, 16, 16, 44, 25, 0, time.FixedZone("CST", 8*60*60))
	m, _ := Format(n, "NAS-01", at, results)
	if m.Title != "DockerCopilot · 成功 1 · 失败 2 · 检查异常 1" || !strings.HasPrefix(m.Body, "NAS-01 · 11-16 16:44\n") {
		t.Fatal("汇总缺少简洁结论或设备时间", m)
	}
	for _, line := range []string{"失败：redis · redis:7 · 已恢复", "失败：db · postgres:16 · 恢复失败，需处理", "检查异常：web · example/web:latest", "成功：nginx · nginx:latest"} {
		if !strings.Contains(m.Body, line) {
			t.Fatal("混合结果缺少状态或恢复信息", line, m)
		}
	}
	if strings.Index(m.Body, "检查异常：") > strings.Index(m.Body, "成功：") || strings.Index(m.Body, "失败：") > strings.Index(m.Body, "检查异常：") {
		t.Fatal("异常没有优先显示", m)
	}
	n.UpdateFailed, n.CheckFailed = false, false
	m, _ = Format(n, "NAS-01", at, results)
	if m.Title != "DockerCopilot · 更新成功 1 项" || m.Body != "NAS-01 · 11-16 16:44\nnginx · nginx:latest" {
		t.Fatal("过滤后单类结果仍重复标注状态", m)
	}
	n.UpdateFailed, n.UpdateSucceeded = true, false
	m, _ = Format(n, "NAS-01", at, results)
	if m.Title != "DockerCopilot · 更新失败 2 项" || strings.Contains(m.Body, "失败：") || !strings.Contains(m.Body, "已恢复") || !strings.Contains(m.Body, "恢复失败，需处理") {
		t.Fatal("单类失败丢失恢复状态或重复标注", m)
	}
}
