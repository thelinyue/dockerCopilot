package container

import (
	"context"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
	"github.com/zeromicro/go-zero/core/logx"
	"os"
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
	taskID, err := l.svcCtx.RunTask("更新容器", func(taskID string) error {
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
