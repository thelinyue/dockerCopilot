package icons

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest/pathvar"
)

// 公开入口只读取栅格图片，不能列目录或转发任意 API；远端认证信息始终留在服务端。
func PublicHandler(ctx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vars := pathvar.Vars(r)
		name, device := vars["file"], vars["device"]
		expected, allowed := allowedImageTypes[strings.ToLower(filepath.Ext(name))]
		if !allowed || name == "" || name != filepath.Base(name) || strings.ContainsAny(name, `/\\:`) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if device == "" || device == "local" {
			path, err := iconFilePath(name)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			file, err := os.Open(path)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer file.Close()
			info, err := file.Stat()
			if err != nil || !info.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			header := make([]byte, 512)
			n, _ := file.Read(header)
			if http.DetectContentType(header[:n]) != expected {
				http.NotFound(w, r)
				return
			}
			if _, err = file.Seek(0, io.SeekStart); err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", expected)
			http.ServeContent(w, r, name, info.ModTime(), file)
			return
		}
		if ctx.Devices == nil {
			http.NotFound(w, r)
			return
		}
		remote, found := ctx.Devices.Find(device)
		if !found {
			http.NotFound(w, r)
			return
		}
		response, err := ctx.Devices.Request(remote, http.MethodGet, "/api/icon-file?name="+url.QueryEscape(name), nil, make(http.Header))
		if err != nil {
			http.Error(w, "设备图片暂不可用", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			http.NotFound(w, r)
			return
		}
		// 兼容旧节点的上传上限，同时阻止错误配置把公开图片入口变成大文件下载代理。
		content, err := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		if err != nil || len(content) > 16<<20 || http.DetectContentType(content) != expected {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", expected)
		w.Write(content)
	}
}
