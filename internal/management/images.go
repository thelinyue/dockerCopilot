package management

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/docker/docker/api/types/filters"
)

func (m *Manager) pruneImages(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type string `json:"type"`
	}
	if err := decode(w, r, &req); err != nil {
		reply(w, nil, err)
		return
	}
	if req.Type != "dangling" && req.Type != "unused" {
		reply(w, nil, fmt.Errorf("清理类型无效，请选择无Tag或未使用镜像"))
		return
	}
	// 由引擎检查容器引用并处理多标签，不在应用端强制逐个删除。
	report, err := m.Context.DockerClient.ImagesPrune(r.Context(), filters.NewArgs(filters.Arg("dangling", strconv.FormatBool(req.Type == "dangling"))))
	if err != nil {
		reply(w, nil, fmt.Errorf("镜像清理失败，请刷新列表确认实际结果后重试: %w", err))
		return
	}
	// 引擎报告含标签和层记录，不能直接将记录条数当成已删除镜像数。
	reply(w, map[string]any{"changed": len(report.ImagesDeleted) > 0, "spaceReclaimed": report.SpaceReclaimed}, nil)
}
