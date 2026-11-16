package icons

import (
	"net/http"

	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/zeromicro/go-zero/rest/httpx"
)

func ObtainHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		values, err := loadIcons()
		if err != nil {
			writeUploadError(w, 500, err.Error())
			return
		}
		httpx.OkJsonCtx(r.Context(), w, types.Resp{Code: 200, Msg: "图标读取成功", Data: values})
	}
}

func DeleteHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		repository, err := normalizeRepository(r.URL.Query().Get("imageName"))
		if err != nil {
			writeUploadError(w, 400, err.Error())
			return
		}
		warning, err := changeIcon(repository, "")
		if err != nil {
			writeUploadError(w, 500, err.Error())
			return
		}
		message := "自定义图标已删除，该镜像仓库的全部标签已恢复默认图标"
		if warning != "" {
			message = warning
		}
		httpx.OkJsonCtx(r.Context(), w, types.Resp{Code: 200, Msg: message, Data: map[string]string{}})
	}
}

func FileHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path, err := iconFilePath(r.URL.Query().Get("name"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, path)
	}
}
