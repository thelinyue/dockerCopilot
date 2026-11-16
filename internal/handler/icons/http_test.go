package icons

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"github.com/onlyLTY/dockerCopilot/internal/management"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/zeromicro/go-zero/rest/pathvar"
)

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var content bytes.Buffer
	if err := png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return content.Bytes()
}

func uploadRequest(t *testing.T, name, filename string, content []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	file.Write(content)
	form.WriteField("imageName", name)
	form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/icons", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	return request
}

func TestUploadSupportedFormatsAndExactSizeLimit(t *testing.T) {
	var jpegData, gifData bytes.Buffer
	bitmap := image.NewRGBA(image.Rect(0, 0, 2, 2))
	if err := jpeg.Encode(&jpegData, bitmap, nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.Encode(&gifData, bitmap, nil); err != nil {
		t.Fatal(err)
	}
	webpData, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	paddedPNG := append(pngBytes(t), make([]byte, maxIconBytes-len(pngBytes(t)))...)
	for _, scenario := range []struct {
		filename string
		content  []byte
	}{
		{"icon.png", paddedPNG}, {"icon.JPG", jpegData.Bytes()}, {"icon.jpeg", jpegData.Bytes()},
		{"icon.gif", gifData.Bytes()}, {"icon.webp", webpData},
	} {
		t.Run(scenario.filename, func(t *testing.T) {
			setupIconStore(t)
			recorder := httptest.NewRecorder()
			UploadHandler(nil)(recorder, uploadRequest(t, "redis:7", scenario.filename, scenario.content))
			if recorder.Code != 200 {
				t.Fatalf("format rejected: %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestIconHTTPRoundTripAndValidation(t *testing.T) {
	setupIconStore(t)
	for _, scenario := range []struct {
		name, filename string
		content        []byte
	}{
		{"redis", "icon.svg", []byte("<svg/>")},
		{"redis", "icon.png", []byte("not a png")},
		{"redis", "icon.jpg", pngBytes(t)},
		{"redis", "large.png", make([]byte, maxIconBytes+1)},
		{"invalid image", "icon.png", pngBytes(t)},
	} {
		recorder := httptest.NewRecorder()
		UploadHandler(nil)(recorder, uploadRequest(t, scenario.name, scenario.filename, scenario.content))
		if recorder.Code != 400 {
			t.Fatalf("%s: got %d %s", scenario.filename, recorder.Code, recorder.Body.String())
		}
	}
	recorder := httptest.NewRecorder()
	ObtainHandler(nil)(recorder, httptest.NewRequest("GET", "/api/icons", nil))
	if !strings.Contains(recorder.Body.String(), `"data":{}`) {
		t.Fatalf("empty response: %s", recorder.Body.String())
	}
	data := pngBytes(t)
	recorder = httptest.NewRecorder()
	UploadHandler(nil)(recorder, uploadRequest(t, "docker.io/library/redis:7", "valid.png", data))
	var response struct {
		Data string `json:"data"`
	}
	json.Unmarshal(recorder.Body.Bytes(), &response)
	if recorder.Code != 200 || response.Data == "" {
		t.Fatalf("upload: %d %s", recorder.Code, recorder.Body.String())
	}
	values, _ := loadIcons()
	if values["redis"] != iconPathPrefix+response.Data || len(values) != 1 {
		t.Fatalf("not repository mapping: %v", values)
	}
	recorder = httptest.NewRecorder()
	FileHandler(nil)(recorder, httptest.NewRequest("GET", "/api/icon-file?name="+response.Data, nil))
	if recorder.Code != 200 || !bytes.Equal(recorder.Body.Bytes(), data) {
		t.Fatal("actual stored image differs")
	}
	recorder = httptest.NewRecorder()
	DeleteHandler(nil)(recorder, httptest.NewRequest("DELETE", "/api/icons?imageName=redis:8", nil))
	if recorder.Code != 200 {
		t.Fatalf("delete: %s", recorder.Body.String())
	}
	values, _ = loadIcons()
	if len(values) != 0 {
		t.Fatalf("delete left mappings: %v", values)
	}
	if _, err := os.Stat(filepath.Join(imageUploadDir, response.Data)); !os.IsNotExist(err) {
		t.Fatalf("unused upload not removed: %v", err)
	}
}

func TestUploadKeepsDamagedConfigAndRemovesUncommittedImage(t *testing.T) {
	setupIconStore(t)
	before := "export const customImageLogos = { damaged"
	os.WriteFile(imageLogosPath, []byte(before), 0644)
	recorder := httptest.NewRecorder()
	UploadHandler(nil)(recorder, uploadRequest(t, "redis", "icon.png", pngBytes(t)))
	if recorder.Code != 500 {
		t.Fatalf("expected config failure, got %s", recorder.Body.String())
	}
	after, _ := os.ReadFile(imageLogosPath)
	files, _ := os.ReadDir(imageUploadDir)
	if string(after) != before || len(files) != 0 {
		t.Fatal("failed upload damaged existing data or leaked new image")
	}
}

func verifyFailedUpload(t *testing.T) {
	t.Helper()
	before, err := os.ReadFile(imageLogosPath)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	UploadHandler(nil)(recorder, uploadRequest(t, "redis:8", "icon.png", pngBytes(t)))
	if recorder.Code != 500 {
		t.Fatalf("expected save failure: %d %s", recorder.Code, recorder.Body.String())
	}
	after, _ := os.ReadFile(imageLogosPath)
	files, _ := os.ReadDir(imageUploadDir)
	if !bytes.Equal(before, after) || len(files) != 0 {
		t.Fatal("save failure damaged old mapping or leaked new image")
	}
}

func TestManagementRequiresLoginButPublicImagesDoNot(t *testing.T) {
	setupIconStore(t)
	ensureImageDirectory()
	filename := "11111111-1111-4111-8111-111111111111.png"
	content := pngBytes(t)
	os.WriteFile(filepath.Join(imageUploadDir, filename), content, 0644)
	ctx := &svc.ServiceContext{}
	ctx.Config.Auth.AccessSecret = "icon-test-only-secret"
	manager := management.New(ctx)
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte(ctx.Config.Auth.AccessSecret))
	for _, endpoint := range []struct {
		method, path string
		handler      http.HandlerFunc
	}{
		{"GET", "/api/icons", ObtainHandler(ctx)},
		{"POST", "/api/icons", UploadHandler(ctx)},
		{"DELETE", "/api/icons?imageName=redis", DeleteHandler(ctx)},
		{"GET", "/api/icon-file?name=" + filename, FileHandler(ctx)},
	} {
		recorder := httptest.NewRecorder()
		manager.Wrap(endpoint.handler)(recorder, httptest.NewRequest(endpoint.method, endpoint.path, nil))
		if recorder.Code != 401 {
			t.Fatalf("unprotected management route: %s %s", endpoint.method, endpoint.path)
		}
	}
	request := httptest.NewRequest("GET", "/api/icon-file?name="+filename, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	manager.Wrap(FileHandler(ctx))(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("authenticated read failed: %d", recorder.Code)
	}
	for _, device := range []string{"", "local"} {
		request = pathvar.WithVars(httptest.NewRequest("GET", "/icons/local/"+filename, nil), map[string]string{"device": device, "file": filename})
		recorder = httptest.NewRecorder()
		PublicHandler(ctx)(recorder, request)
		if recorder.Code != 200 || !bytes.Equal(recorder.Body.Bytes(), content) {
			t.Fatalf("public read: %d", recorder.Code)
		}
	}
	for _, filename := range []string{"../secret.png", "config.json", "fake.png"} {
		os.WriteFile(filepath.Join(imageUploadDir, "fake.png"), []byte("not an image"), 0644)
		request = pathvar.WithVars(httptest.NewRequest("GET", "/icons/local/file", nil), map[string]string{"device": "local", "file": filename})
		recorder = httptest.NewRecorder()
		PublicHandler(ctx)(recorder, request)
		if recorder.Code != 404 {
			t.Fatalf("unsafe public read: %s", filename)
		}
	}
}

func TestRemotePublicImageUsesServerCredentialsAndOnlyImageRead(t *testing.T) {
	content := pngBytes(t)
	var imageReads int
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth" {
			io.WriteString(w, `{"code":200,"data":{"jwt":"remote-test-token"}}`)
			return
		}
		if r.Method != "GET" || r.URL.Path != "/api/icon-file" || r.URL.Query().Get("name") != "same.png" || r.Header.Get("Authorization") != "Bearer remote-test-token" || r.Header.Get(node.DeviceHeader) != "" {
			t.Errorf("unexpected public proxy request: %s %s", r.Method, r.URL.Path)
		}
		imageReads++
		w.Header().Set("Content-Type", "image/png")
		w.Write(content)
	}))
	defer remote.Close()
	devices, err := node.OpenDevices(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	device, err := devices.Save(node.Device{Name: "图片节点", Address: remote.URL, Secret: "remote-test-key"})
	if err != nil {
		t.Fatal(err)
	}
	request := pathvar.WithVars(httptest.NewRequest("GET", "/icons/remote/same.png", nil), map[string]string{"device": device.ID, "file": "same.png"})
	request.Header.Set("Authorization", "Bearer browser-must-not-forward")
	recorder := httptest.NewRecorder()
	PublicHandler(&svc.ServiceContext{Devices: devices})(recorder, request)
	if recorder.Code != 200 || imageReads != 1 || !bytes.Equal(recorder.Body.Bytes(), content) {
		t.Fatalf("remote public read failed: %d", recorder.Code)
	}
}
