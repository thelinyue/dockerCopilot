package icons

import (
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/zeromicro/go-zero/rest/httpx"
)

const maxIconBytes = 2 << 20

var allowedImageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".webp": "image/webp", ".gif": "image/gif",
}

func UploadHandler(svcCtx *svc.ServiceContext) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 表单内存阈值不是文件大小上限；另行限制请求总量及实际文件字节数。
		r.Body = http.MaxBytesReader(w, r.Body, maxIconBytes+(64<<10))
		if err := r.ParseMultipartForm(maxIconBytes); err != nil {
			writeUploadError(w, 400, "无法读取上传表单，请选择不超过 2 MiB 的图片")
			return
		}
		defer r.MultipartForm.RemoveAll()
		file, header, err := r.FormFile("file")
		if err != nil {
			writeUploadError(w, 400, "请选择要上传的图片")
			return
		}
		defer file.Close()
		if header.Size > maxIconBytes {
			writeUploadError(w, 400, "图标文件大小不能超过 2 MiB")
			return
		}
		repository, err := normalizeRepository(r.FormValue("imageName"))
		if err != nil {
			writeUploadError(w, 400, err.Error())
			return
		}
		filename, err := generateStoredFilename(file, header)
		if err != nil {
			writeUploadError(w, 400, err.Error())
			return
		}
		if err = ensureImageDirectory(); err != nil {
			writeUploadError(w, 500, "无法创建图片目录，请检查数据目录权限")
			return
		}
		path := filepath.Join(imageUploadDir, filename)
		destination, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			writeUploadError(w, 500, "无法创建图片文件，请检查数据目录空间及权限")
			return
		}
		committed := false
		defer func() {
			if !committed {
				_ = os.Remove(path)
			}
		}()
		written, copyErr := io.Copy(destination, io.LimitReader(file, maxIconBytes+1))
		if copyErr == nil {
			copyErr = destination.Sync()
		}
		closeErr := destination.Close()
		if written > maxIconBytes {
			writeUploadError(w, 400, "图标文件大小不能超过 2 MiB")
			return
		}
		if copyErr != nil || closeErr != nil {
			writeUploadError(w, 500, "图片写入失败，请检查数据目录空间及权限")
			return
		}
		warning, err := changeIcon(repository, filename)
		if err != nil {
			writeUploadError(w, 500, err.Error())
			return
		}
		committed = true
		message := "图标已保存，已应用到该镜像仓库的全部标签"
		if warning != "" {
			message = warning
		}
		httpx.OkJsonCtx(r.Context(), w, types.Resp{Code: 200, Msg: message, Data: filename})
	}
}

func generateStoredFilename(file multipart.File, header *multipart.FileHeader) (string, error) {
	ext := strings.ToLower(filepath.Ext(header.Filename))
	expected, allowed := allowedImageTypes[ext]
	if !allowed {
		return "", fmt.Errorf("仅支持 PNG、JPEG、WebP、GIF，不支持 SVG，请先转换格式")
	}
	buffer := make([]byte, 512)
	n, err := file.Read(buffer)
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("图片读取失败，请重新选择文件")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", fmt.Errorf("无法读取上传图片，请重新选择文件")
	}
	if http.DetectContentType(buffer[:n]) != expected {
		return "", fmt.Errorf("图片内容与扩展名不一致，请选择有效图片")
	}
	return uuid.NewString() + ext, nil
}

func writeUploadError(w http.ResponseWriter, statusCode int, msg string) {
	httpx.WriteJson(w, statusCode, types.Resp{Code: statusCode, Msg: msg, Data: map[string]interface{}{}})
}
