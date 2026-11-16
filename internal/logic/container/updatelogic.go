package container

import (
	"context"
	"fmt"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
	"github.com/zeromicro/go-zero/core/logx"
	"os"
	"strings"
)

type UpdateLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewUpdateLogic(ctx context.Context, svcCtx *svc.ServiceContext) *UpdateLogic {
	return &UpdateLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *UpdateLogic) Update(req *types.ContainerUpdateReq) (resp *types.Resp, err error) {
	resp = &types.Resp{}
	old, inspectErr := l.svcCtx.DockerClient.ContainerInspect(l.ctx, req.Id)
	if inspectErr != nil || old.Config == nil {
		resp.Code, resp.Msg = 400, "无法读取容器，请刷新列表后重试"
		return resp, fmt.Errorf("%s", resp.Msg)
	}
	taskID, err := l.svcCtx.RunTask("更新容器 "+strings.TrimPrefix(old.Name, "/"), svc.ContainerScope(old), "update", func(taskID string) error {
		if err := l.svcCtx.VerifyContainer(context.Background(), old); err != nil {
			notice := svc.ContainerNotice(old)
			notice.Kind = notify.UpdateFailed
			l.svcCtx.RecordNotice(taskID, notice)
			return err
		}
		imageNameAndTag := req.ImageNameAndTag
		delOldContainer := os.Getenv("DelOldContainer") != "false"
		if req.DelOldContainer == "false" {
			delOldContainer = false
		}
		return utiles.UpdateContainer(l.svcCtx, req.Id, req.ContainerName, imageNameAndTag, delOldContainer, taskID)
	})
	if err != nil {
		resp.Code = 409
		resp.Msg = err.Error()
		return resp, err
	}
	resp.Code = 200
	resp.Msg = "success"
	resp.Data = map[string]string{"taskID": taskID}
	return resp, nil
}
