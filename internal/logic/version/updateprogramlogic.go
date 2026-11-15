package version

import (
	"context"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
	"github.com/zeromicro/go-zero/core/logx"
	"os"
	"time"
)

type UpdateProgramLogic struct {
	logx.Logger
	ctx    context.Context
	svcCtx *svc.ServiceContext
}

func NewUpdateProgramLogic(ctx context.Context, svcCtx *svc.ServiceContext) *UpdateProgramLogic {
	return &UpdateProgramLogic{
		Logger: logx.WithContext(ctx),
		ctx:    ctx,
		svcCtx: svcCtx,
	}
}

func (l *UpdateProgramLogic) UpdateProgram() (resp *types.Resp, err error) {
	resp = &types.Resp{}
	taskID, err := l.svcCtx.RunTask("更新 DockerCopilot 程序", svc.OperationScope{}, "program-update", func(id string) error {
		if err := utiles.UpdateProgram(l.svcCtx); err != nil {
			return err
		}
		// 任务结束后仍拒绝新的变更，避免重启打断刚提交的任务。
		l.svcCtx.SetRestarting()
		go func() { time.Sleep(10 * time.Second); os.Exit(1) }()
		return nil
	})
	if err != nil {
		resp.Code = 409
		resp.Msg = err.Error()
		resp.Data = map[string]interface{}{}
		return resp, err
	}
	resp.Code = 200
	resp.Msg = "success"
	resp.Data = map[string]string{"taskID": taskID}
	return resp, nil
}
