package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// 通知不复用检测代理，不跟随重定向；设备密钥只放在请求体中。
func SendBark(ctx context.Context, settings node.BarkSettings, message Message) error {
	if err := settings.Validate(true); err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	return sendBark(ctx, client, settings, message)
}

func sendBark(ctx context.Context, client *http.Client, settings node.BarkSettings, message Message) error {
	body, err := json.Marshal(struct {
		Message
		DeviceKey string `json:"device_key"`
		Group     string `json:"group"`
	}{message, settings.DeviceKey, "DockerCopilot"})
	if err != nil {
		return fmt.Errorf("无法生成 Bark 消息，请检查通知内容")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(settings.ServerURL, "/")+"/push", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("Bark 服务器地址无效，请检查配置")
	}
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	r.GetBody = nil
	resp, err := client.Do(r)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("Bark 推送超时，请检查网络；为避免重复通知，本次不自动重试")
		}
		return fmt.Errorf("连接 Bark 失败，请检查服务器地址、网络和证书")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Bark 拒绝推送（HTTP %d），请检查服务器地址、设备密钥及服务端日志", resp.StatusCode)
	}
	var result struct {
		Code int `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&result) != nil {
		return fmt.Errorf("Bark 返回无效响应，请确认地址指向 Bark 服务端")
	}
	if result.Code != 200 {
		return fmt.Errorf("Bark 返回业务错误码 %d，请检查设备密钥及服务端日志", result.Code)
	}
	return nil
}
