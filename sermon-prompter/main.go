// 설교 프롬프터 — 예배용 윈도우 컴퓨터에서 실행하는 프로그램.
//
// 실행하면 이 컴퓨터 안에 작은 웹 서버가 켜지고 QR 연결 화면이 브라우저로 열린다.
// 태블릿이 QR 로 접속하면 설교문과 슬라이드를 한 화면에서 보면서
// 이 컴퓨터의 실제 파워포인트 슬라이드 쇼를 넘길 수 있다.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	sim := flag.Bool("sim", false, "파워포인트 없이 연습용 가상 PPT 로 실행")
	port := flag.Int("port", 0, "사용할 포트 (기본: 저장된 포트 또는 8765)")
	noBrowser := flag.Bool("no-browser", false, "연결 화면을 자동으로 열지 않음")
	dataDir := flag.String("data", defaultDataDir(), "설정과 대본을 저장할 폴더")
	flag.Parse()

	_ = os.MkdirAll(*dataDir, 0o755)
	if f, err := os.OpenFile(filepath.Join(*dataDir, "log.txt"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(f)
	}

	srv := newServer(*dataDir, newController(*sim))

	// 포트: 지난번에 쓴 포트를 그대로 쓴다 (태블릿에 저장된 주소가 계속 유효하도록).
	first := 8765
	if srv.cfg.Port > 0 {
		first = srv.cfg.Port
	}
	if *port > 0 {
		first = *port
	}
	var ln net.Listener
	for p := first; p < first+20; p++ {
		l, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", p))
		if err == nil {
			ln, srv.port = l, p
			break
		}
		// 이미 이 프로그램이 켜져 있으면 그 연결 화면만 다시 열고 끝낸다.
		if alreadyRunning(p) {
			if !*noBrowser {
				openBrowser(fmt.Sprintf("http://127.0.0.1:%d/host", p))
			}
			return
		}
	}
	if ln == nil {
		log.Fatal("사용할 수 있는 포트를 찾지 못했습니다")
	}
	srv.cfg.Port = srv.port
	srv.saveCfg()

	hs := &http.Server{Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second}
	if !*noBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(fmt.Sprintf("http://127.0.0.1:%d/host", srv.port))
		}()
	}
	log.Printf("설교 프롬프터 %s — 포트 %d", appVersion, srv.port)
	log.Fatal(hs.Serve(ln))
}

func alreadyRunning(port int) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var v struct {
		App string `json:"app"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&v)
	return v.App == "sermon-prompter"
}
