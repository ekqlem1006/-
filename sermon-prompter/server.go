package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const appVersion = "1.0.0"

//go:embed web
var webFS embed.FS

type client struct {
	CID      string `json:"cid"`
	Name     string `json:"name"`
	Local    bool   `json:"local"` // 이 컴퓨터의 브라우저인지
	Online   bool   `json:"online"`
	conns    int
	lastSeen time.Time
}

type Server struct {
	cfg     Config
	dataDir string
	port    int
	pcName  string
	ppt     Controller

	mu         sync.Mutex
	clients    map[string]*client
	controlCID string
	docs       map[string]json.RawMessage
	docsVer    int
	subs       map[chan struct{}]struct{}
}

func newServer(dataDir string, ppt Controller) *Server {
	s := &Server{
		dataDir: dataDir,
		ppt:     ppt,
		clients: map[string]*client{},
		docs:    map[string]json.RawMessage{},
		subs:    map[chan struct{}]struct{}{},
	}
	_ = readJSON(s.cfgPath(), &s.cfg)
	if len(s.cfg.Token) < 8 {
		s.cfg.Token = newToken()
	}
	_ = readJSON(s.docsPath(), &s.docs)
	if s.docs == nil {
		s.docs = map[string]json.RawMessage{}
	}
	s.pcName, _ = os.Hostname()
	go func() {
		for range ppt.Changes() {
			s.broadcast()
		}
	}()
	return s
}

func (s *Server) cfgPath() string  { return filepath.Join(s.dataDir, "config.json") }
func (s *Server) docsPath() string { return filepath.Join(s.dataDir, "sermons.json") }

func (s *Server) saveCfg() { _ = writeJSON(s.cfgPath(), s.cfg) }

func (s *Server) broadcast() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// ---- 상태 ----------------------------------------------------------------

func (s *Server) stateJSON() []byte {
	ppt := s.ppt.State()
	s.mu.Lock()
	defer s.mu.Unlock()
	list := make([]*client, 0, len(s.clients))
	for _, c := range s.clients {
		c.Online = c.conns > 0
		list = append(list, c)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CID < list[j].CID })
	var control interface{}
	if c := s.clients[s.controlCID]; c != nil {
		control = c
	}
	dept := s.cfg.Dept
	b, _ := json.Marshal(map[string]interface{}{
		"host":    map[string]interface{}{"dept": dept, "pc": s.pcName, "version": appVersion},
		"ppt":     ppt,
		"control": control,
		"clients": list,
		"docsVer": s.docsVer,
	})
	return b
}

// ---- 인증 ----------------------------------------------------------------

func isLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) authed(r *http.Request) bool {
	if isLocal(r) {
		return true
	}
	k := r.URL.Query().Get("k")
	return subtle.ConstantTimeCompare([]byte(k), []byte(s.cfg.Token)) == 1
}

func writeJSONResp(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSONResp(w, code, map[string]interface{}{"ok": false, "error": msg})
}

// api 는 인증과 요청 형식을 확인한 뒤 처리기를 부른다.
// POST 는 전용 헤더가 있어야 하므로, 다른 웹사이트가 몰래 이 컴퓨터로 명령을 보낼 수 없다.
func (s *Server) api(localOnly bool, h func(w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if localOnly && !isLocal(r) {
			fail(w, http.StatusForbidden, "예배용 컴퓨터에서만 할 수 있는 작업입니다")
			return
		}
		if !s.authed(r) {
			fail(w, http.StatusUnauthorized, "연결 키가 맞지 않습니다. 컴퓨터 화면의 QR 을 다시 찍어 주세요")
			return
		}
		if r.Method == http.MethodPost {
			if r.Header.Get("X-SP") == "" {
				fail(w, http.StatusForbidden, "잘못된 요청입니다")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
		}
		h(w, r)
	}
}

type cmdBody struct {
	CID     string `json:"cid"`
	Action  string `json:"action"`
	SlideID int    `json:"slideId"`
	CurID   int    `json:"curId"`
	Dir     int    `json:"dir"`
	On      bool   `json:"on"`
	Dept    string `json:"dept"`
	ID      string `json:"id"`
	N       int    `json:"n"`
}

func readBody(r *http.Request) (cmdBody, error) {
	var b cmdBody
	err := json.NewDecoder(r.Body).Decode(&b)
	return b, err
}

// hasControl 은 요청한 기기가 지금 조작 권한을 가지고 있는지 확인한다.
func (s *Server) hasControl(cid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cid != "" && s.controlCID == cid
}

func (s *Server) touchClient(cid, name string, local bool) *client {
	c := s.clients[cid]
	if c == nil {
		c = &client{CID: cid}
		s.clients[cid] = c
	}
	if name != "" {
		c.Name = name
	}
	c.Local = local
	c.lastSeen = time.Now()
	return c
}

// ---- 처리기 --------------------------------------------------------------

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/host" {
			if !isLocal(r) {
				http.Redirect(w, r, "/", http.StatusFound)
				return
			}
			r.URL.Path = "/host.html"
		}
		static.ServeHTTP(w, r)
	})

	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSONResp(w, 200, map[string]interface{}{"app": "sermon-prompter", "version": appVersion})
	})

	mux.HandleFunc("/api/state", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(s.stateJSON())
	}))

	mux.HandleFunc("/api/events", s.api(false, s.handleEvents))

	mux.HandleFunc("/api/control", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		b, err := readBody(r)
		if err != nil || b.CID == "" {
			fail(w, 400, "잘못된 요청입니다")
			return
		}
		s.mu.Lock()
		s.touchClient(b.CID, "", isLocal(r))
		ok := true
		msg := ""
		switch b.Action {
		case "acquire":
			if s.controlCID != "" && s.controlCID != b.CID {
				ok, msg = false, "다른 기기가 조작 중입니다"
			} else {
				s.controlCID = b.CID
			}
		case "takeover":
			s.controlCID = b.CID
		case "release":
			if s.controlCID == b.CID {
				s.controlCID = ""
			}
		case "forceRelease": // 컴퓨터 화면에서 조작 권한 회수
			if isLocal(r) {
				s.controlCID = ""
			} else {
				ok, msg = false, "예배용 컴퓨터에서만 할 수 있습니다"
			}
		default:
			ok, msg = false, "잘못된 요청입니다"
		}
		s.mu.Unlock()
		s.broadcast()
		if !ok {
			fail(w, http.StatusConflict, msg)
			return
		}
		writeJSONResp(w, 200, map[string]interface{}{"ok": true})
	}))

	// 실제 송출 화면을 바꾸는 명령은 조작 권한을 가진 기기만 보낼 수 있다.
	live := func(h func(b cmdBody) error) http.HandlerFunc {
		return s.api(false, func(w http.ResponseWriter, r *http.Request) {
			b, err := readBody(r)
			if err != nil {
				fail(w, 400, "잘못된 요청입니다")
				return
			}
			if !s.hasControl(b.CID) {
				fail(w, http.StatusConflict, "조작 권한이 없습니다. '설교 조작 시작'을 먼저 눌러 주세요")
				return
			}
			if err := h(b); err != nil {
				fail(w, http.StatusBadGateway, err.Error())
				return
			}
			s.broadcast()
			writeJSONResp(w, 200, map[string]interface{}{"ok": true})
		})
	}
	mux.HandleFunc("/api/goto", live(func(b cmdBody) error { return s.ppt.Goto(b.SlideID) }))
	mux.HandleFunc("/api/step", live(func(b cmdBody) error {
		// 태블릿이 보고 있는 슬라이드가 실제 송출 중일 때만 애니메이션을 진행한다.
		if st := s.ppt.State(); st.CurID != b.CurID {
			return nil
		}
		return s.ppt.Step(b.Dir)
	}))
	mux.HandleFunc("/api/black", live(func(b cmdBody) error { return s.ppt.SetBlack(b.On) }))
	mux.HandleFunc("/api/startshow", live(func(b cmdBody) error { return s.ppt.StartShow(b.SlideID) }))

	mux.HandleFunc("/api/refresh", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		s.ppt.Refresh()
		s.broadcast()
		writeJSONResp(w, 200, map[string]interface{}{"ok": true})
	}))

	mux.HandleFunc("/api/thumb", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(r.URL.Query().Get("id"))
		b, err := s.ppt.Thumb(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=600")
		_, _ = w.Write(b)
	}))

	mux.HandleFunc("/api/docs", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		list := make([]json.RawMessage, 0, len(s.docs))
		for _, d := range s.docs {
			list = append(list, d)
		}
		ver := s.docsVer
		s.mu.Unlock()
		writeJSONResp(w, 200, map[string]interface{}{"ok": true, "docs": list, "docsVer": ver})
	}))

	mux.HandleFunc("/api/doc", s.api(false, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			fail(w, 405, "잘못된 요청입니다")
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			fail(w, 400, "대본이 너무 큽니다")
			return
		}
		var meta struct {
			ID     string `json:"id"`
			Delete bool   `json:"delete"`
		}
		if json.Unmarshal(raw, &meta) != nil || meta.ID == "" {
			fail(w, 400, "잘못된 요청입니다")
			return
		}
		s.mu.Lock()
		if meta.Delete {
			delete(s.docs, meta.ID)
		} else {
			s.docs[meta.ID] = json.RawMessage(raw)
		}
		s.docsVer++
		ver := s.docsVer
		err = writeJSON(s.docsPath(), s.docs)
		s.mu.Unlock()
		if err != nil {
			fail(w, 500, "컴퓨터에 저장하지 못했습니다: "+err.Error())
			return
		}
		s.broadcast()
		writeJSONResp(w, 200, map[string]interface{}{"ok": true, "docsVer": ver})
	}))

	// ---- 예배용 컴퓨터 화면 전용 ----
	mux.HandleFunc("/api/hostinfo", s.api(true, func(w http.ResponseWriter, r *http.Request) {
		ips := lanIPs()
		type entry struct {
			IP    string `json:"ip"`
			Iface string `json:"iface"`
			URL   string `json:"url"`
		}
		list := []entry{}
		for _, a := range ips {
			list = append(list, entry{a.IP, a.Iface, s.tabletURL(a.IP)})
		}
		exe, _ := os.Executable()
		writeJSONResp(w, 200, map[string]interface{}{
			"ok": true, "addrs": list, "port": s.port, "dept": s.cfg.Dept, "pc": s.pcName,
			"dataDir": s.dataDir, "exe": exe, "firewallHelper": firewallHelper, "version": appVersion,
		})
	}))

	mux.HandleFunc("/api/qr", s.api(true, func(w http.ResponseWriter, r *http.Request) {
		ip := r.URL.Query().Get("ip")
		if net.ParseIP(ip) == nil {
			http.Error(w, "bad ip", 400)
			return
		}
		png, err := qrcode.Encode(s.tabletURL(ip), qrcode.Medium, 640)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(png)
	}))

	mux.HandleFunc("/api/host", s.api(true, func(w http.ResponseWriter, r *http.Request) {
		b, err := readBody(r)
		if err != nil {
			fail(w, 400, "잘못된 요청입니다")
			return
		}
		switch b.Action {
		case "dept":
			s.mu.Lock()
			s.cfg.Dept = strings.TrimSpace(b.Dept)
			s.saveCfg()
			s.mu.Unlock()
			s.broadcast()
		case "newKey": // 연결 키를 새로 만들어 이전에 연결했던 기기를 모두 끊는다
			s.mu.Lock()
			s.cfg.Token = newToken()
			s.controlCID = ""
			s.saveCfg()
			s.mu.Unlock()
			s.broadcast()
		case "firewall":
			if err := addFirewallRule(); err != nil {
				fail(w, 500, "방화벽 설정을 열지 못했습니다: "+err.Error())
				return
			}
		case "quit":
			writeJSONResp(w, 200, map[string]interface{}{"ok": true})
			go func() {
				time.Sleep(300 * time.Millisecond)
				os.Exit(0)
			}()
			return
		default:
			fail(w, 400, "잘못된 요청입니다")
			return
		}
		writeJSONResp(w, 200, map[string]interface{}{"ok": true})
	}))

	// 개발·시험용: 가상 PPT 에서 방송실 수동 조작과 PPT 수정을 흉내 낸다.
	if sim, ok := s.ppt.(*simController); ok {
		mux.HandleFunc("/api/sim", s.api(true, func(w http.ResponseWriter, r *http.Request) {
			b, _ := readBody(r)
			sim.simCommand(b.Action, b.N)
			writeJSONResp(w, 200, map[string]interface{}{"ok": true})
		}))
	}
	return mux
}

func (s *Server) tabletURL(ip string) string {
	return fmt.Sprintf("http://%s:%d/?k=%s", ip, s.port, s.cfg.Token)
}

// handleEvents 는 상태가 바뀔 때마다 기기에 바로 알려 주는 통로(SSE)다.
// 2초마다 신호를 보내서, 기기 쪽에서 연결이 끊겼는지 빨리 알 수 있게 한다.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	q := r.URL.Query()
	cid := q.Get("cid")
	if cid == "" || len(cid) > 64 {
		http.Error(w, "cid", 400)
		return
	}
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	c := s.touchClient(cid, q.Get("name"), isLocal(r))
	c.conns++
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	s.broadcast()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		c.conns--
		c.lastSeen = time.Now()
		// 오래 접속하지 않은 기기는 목록에서 정리한다 (조작 권한을 가진 기기는 남긴다).
		for id, o := range s.clients {
			if o.conns <= 0 && id != s.controlCID && time.Since(o.lastSeen) > 30*time.Minute {
				delete(s.clients, id)
			}
		}
		s.mu.Unlock()
		s.broadcast()
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	send := func() bool {
		if _, err := fmt.Fprintf(w, "event: state\ndata: %s\n\n", s.stateJSON()); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	if !send() {
		return
	}
	hb := time.NewTicker(2 * time.Second)
	defer hb.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			if !send() {
				return
			}
		case <-hb.C:
			if _, err := io.WriteString(w, "event: hb\ndata: 1\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// ---- 네트워크 주소 --------------------------------------------------------

type lanAddr struct{ IP, Iface string }

// lanIPs 는 태블릿이 접속할 수 있는 이 컴퓨터의 내부 네트워크 주소를 찾는다.
// 인터넷으로 나가는 길에 쓰이는 주소(대개 공유기에 연결된 주소)를 맨 앞에 둔다.
func lanIPs() []lanAddr {
	preferred := ""
	if conn, err := net.Dial("udp4", "8.8.8.8:80"); err == nil { // 실제로 패킷을 보내지는 않는다
		if ua, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			preferred = ua.IP.String()
		}
		conn.Close()
	}
	var out []lanAddr
	ifaces, _ := net.Interfaces()
	for _, in := range ifaces {
		if in.Flags&net.FlagUp == 0 || in.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := in.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, lanAddr{ip.String(), in.Name})
		}
	}
	score := func(a lanAddr) int {
		ip := net.ParseIP(a.IP)
		switch {
		case a.IP == preferred:
			return 0
		case ip.IsPrivate():
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool { return score(out[i]) < score(out[j]) })
	return out
}
