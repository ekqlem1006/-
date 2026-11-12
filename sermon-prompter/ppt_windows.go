//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// 파워포인트 상수 (PpSlideShowState)
const (
	ppShowRunning = 1
	ppShowBlack   = 3
)

// winController 는 실행 중인 설치형 PowerPoint 를 COM 자동화로 조작한다.
// 파워포인트를 새로 띄우거나 붙잡아 두지 않고, 매번 "지금 실행 중인"
// 파워포인트에 잠깐 연결했다가 놓는다. 그래서 방송실의 수동 조작이나
// 파워포인트 종료를 방해하지 않는다.
type winController struct {
	mu sync.Mutex
	st PptState
	ch chan struct{}

	reqs    chan comReq
	rescan  atomic.Bool
	sig     string            // 슬라이드 구성 서명 (COM 스레드 전용)
	thumbs  map[string][]byte // 미리보기 캐시 (COM 스레드 전용)
	fails   int
	pollN   int
	slideCt int
}

type comReq struct {
	fn   func() error
	done chan error
}

func newController(sim bool) Controller {
	if sim {
		return newSimController()
	}
	c := &winController{
		ch:     make(chan struct{}, 1),
		reqs:   make(chan comReq, 64),
		thumbs: map[string][]byte{},
	}
	go c.run()
	return c
}

func (c *winController) State() PptState {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.st
	st.Slides = append([]SlideInfo(nil), c.st.Slides...)
	return st
}

func (c *winController) Changes() <-chan struct{} { return c.ch }

func (c *winController) Refresh() {
	c.rescan.Store(true)
	_ = c.do(func() error { return nil })
}

// do 는 COM 전용 스레드에서 fn 을 실행하고 결과를 기다린다.
func (c *winController) do(fn func() error) error {
	r := comReq{fn: fn, done: make(chan error, 1)}
	select {
	case c.reqs <- r:
	default:
		return errBusy
	}
	select {
	case err := <-r.done:
		return err
	case <-time.After(10 * time.Second):
		return errBusy
	}
}

func (c *winController) run() {
	runtime.LockOSThread()
	_ = ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED)
	t := time.NewTicker(400 * time.Millisecond)
	defer t.Stop()
	c.poll()
	for {
		select {
		case r := <-c.reqs:
			r.done <- safeCall(r.fn)
			c.poll()
		case <-t.C:
			c.poll()
		}
	}
}

func safeCall(fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("파워포인트 조작 중 오류: %v", r)
		}
	}()
	return fn()
}

// ---- COM 도우미 ----------------------------------------------------------

// scope 는 COM 호출로 받은 값들을 모아 두었다가 한꺼번에 해제한다.
type scope struct{ vars []*ole.VARIANT }

func (s *scope) close() {
	for i := len(s.vars) - 1; i >= 0; i-- {
		_ = s.vars[i].Clear()
	}
	s.vars = nil
}

func (s *scope) keep(v *ole.VARIANT, err error, what string) (*ole.IDispatch, error) {
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, fmt.Errorf("%s: 값 없음", what)
	}
	s.vars = append(s.vars, v)
	if v.VT != ole.VT_DISPATCH || v.Val == 0 {
		return nil, fmt.Errorf("%s: 개체가 아님", what)
	}
	return v.ToIDispatch(), nil
}

// obj 는 개체를 돌려주는 속성을 읽는다.
func (s *scope) obj(d *ole.IDispatch, name string, args ...interface{}) (*ole.IDispatch, error) {
	v, err := oleutil.GetProperty(d, name, args...)
	return s.keep(v, err, name)
}

// call 은 개체를 돌려주는 메서드를 호출한다.
func (s *scope) call(d *ole.IDispatch, name string, args ...interface{}) (*ole.IDispatch, error) {
	v, err := oleutil.CallMethod(d, name, args...)
	return s.keep(v, err, name)
}

func getVal(d *ole.IDispatch, name string) (interface{}, error) {
	v, err := oleutil.GetProperty(d, name)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	defer v.Clear()
	return v.Value(), nil
}

func callVal(d *ole.IDispatch, name string, args ...interface{}) (interface{}, error) {
	v, err := oleutil.CallMethod(d, name, args...)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	defer v.Clear()
	return v.Value(), nil
}

func callVoid(d *ole.IDispatch, name string, args ...interface{}) error {
	v, err := oleutil.CallMethod(d, name, args...)
	if v != nil {
		_ = v.Clear()
	}
	return err
}

func putVal(d *ole.IDispatch, name string, val interface{}) error {
	v, err := oleutil.PutProperty(d, name, val)
	if v != nil {
		_ = v.Clear()
	}
	return err
}

func toInt(x interface{}) int {
	switch n := x.(type) {
	case int:
		return n
	case int8:
		return int(n)
	case int16:
		return int(n)
	case int32:
		return int(n)
	case int64:
		return int(n)
	case uint:
		return int(n)
	case uint8:
		return int(n)
	case uint16:
		return int(n)
	case uint32:
		return int(n)
	case uint64:
		return int(n)
	case float32:
		return int(n)
	case float64:
		return int(n)
	case bool:
		if n {
			return -1
		}
	}
	return 0
}

func toFloat(x interface{}) float64 {
	switch n := x.(type) {
	case float32:
		return float64(n)
	case float64:
		return n
	}
	return float64(toInt(x))
}

func getInt(d *ole.IDispatch, name string) (int, error) {
	x, err := getVal(d, name)
	return toInt(x), err
}

func getStr(d *ole.IDispatch, name string) string {
	x, err := getVal(d, name)
	if err != nil {
		return ""
	}
	s, _ := x.(string)
	return s
}

// withApp 은 실행 중인 파워포인트에 연결해 fn 을 실행한다.
func withApp(fn func(app *ole.IDispatch) error) error {
	unk, err := oleutil.GetActiveObject("PowerPoint.Application")
	if err != nil || unk == nil {
		return errNoApp
	}
	defer unk.Release()
	app, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil || app == nil {
		return errNoApp
	}
	defer app.Release()
	return fn(app)
}

// target 은 조작 대상 프레젠테이션과 (쇼 실행 중이면) 슬라이드 쇼 보기를 찾는다.
// 슬라이드 쇼가 실행 중이면 그 PPT 를, 아니면 지금 활성화된 PPT 를 고른다.
func target(sc *scope, app *ole.IDispatch) (pres, view *ole.IDispatch) {
	if wins, err := sc.obj(app, "SlideShowWindows"); err == nil {
		if n, _ := getInt(wins, "Count"); n >= 1 {
			if w, err := sc.call(wins, "Item", 1); err == nil {
				v, err1 := sc.obj(w, "View")
				p, err2 := sc.obj(w, "Presentation")
				if err1 == nil && err2 == nil {
					return p, v
				}
			}
		}
	}
	if p, err := sc.obj(app, "ActivePresentation"); err == nil {
		return p, nil
	}
	if all, err := sc.obj(app, "Presentations"); err == nil {
		if n, _ := getInt(all, "Count"); n >= 1 {
			if p, err := sc.call(all, "Item", 1); err == nil {
				return p, nil
			}
		}
	}
	return nil, nil
}

func cleanTitle(s string) string {
	s = strings.NewReplacer("\r", " ", "\n", " ", "\v", " ", "\t", " ").Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 60 {
		s = string(r[:60]) + "…"
	}
	return s
}

// slideTitle 은 슬라이드의 제목(없으면 첫 글상자 내용)을 읽는다.
func slideTitle(slide *ole.IDispatch) string {
	sc := &scope{}
	defer sc.close()
	shapes, err := sc.obj(slide, "Shapes")
	if err != nil {
		return ""
	}
	if has, _ := getInt(shapes, "HasTitle"); has != 0 {
		if t, err := sc.obj(shapes, "Title"); err == nil {
			if tf, err := sc.obj(t, "TextFrame"); err == nil {
				if tr, err := sc.obj(tf, "TextRange"); err == nil {
					if s := cleanTitle(getStr(tr, "Text")); s != "" {
						return s
					}
				}
			}
		}
	}
	n, _ := getInt(shapes, "Count")
	for i := 1; i <= n && i <= 12; i++ {
		s := func() string {
			in := &scope{}
			defer in.close()
			sh, err := in.call(shapes, "Item", i)
			if err != nil {
				return ""
			}
			if has, _ := getInt(sh, "HasTextFrame"); has == 0 {
				return ""
			}
			tf, err := in.obj(sh, "TextFrame")
			if err != nil {
				return ""
			}
			if has, _ := getInt(tf, "HasText"); has == 0 {
				return ""
			}
			tr, err := in.obj(tf, "TextRange")
			if err != nil {
				return ""
			}
			return cleanTitle(getStr(tr, "Text"))
		}()
		if s != "" {
			return s
		}
	}
	return ""
}

// ---- 상태 읽기 -----------------------------------------------------------

func (c *winController) publish(st PptState) {
	c.mu.Lock()
	old := c.st
	c.st = st
	c.mu.Unlock()
	changed := old.AppRunning != st.AppRunning || old.PresOpen != st.PresOpen ||
		old.PresName != st.PresName || old.PresPath != st.PresPath ||
		old.SlidesVer != st.SlidesVer || old.ShowRunning != st.ShowRunning ||
		old.CurID != st.CurID || old.CurIndex != st.CurIndex || old.Black != st.Black ||
		old.ClickIndex != st.ClickIndex || old.ClickCount != st.ClickCount
	if changed {
		select {
		case c.ch <- struct{}{}:
		default:
		}
	}
}

func (c *winController) poll() {
	c.pollN++
	prev := c.State()
	st := PptState{SlidesVer: prev.SlidesVer}
	err := safeCall(func() error {
		return withApp(func(app *ole.IDispatch) error {
			st.AppRunning = true
			sc := &scope{}
			defer sc.close()
			pres, view := target(sc, app)
			if pres == nil {
				return nil
			}
			slides, err := sc.obj(pres, "Slides")
			if err != nil {
				return err
			}
			count, err := getInt(slides, "Count")
			if err != nil {
				return err
			}
			st.PresOpen = true
			st.PresName = getStr(pres, "Name")
			st.PresPath = getStr(pres, "FullName")
			st.Slides, st.Aspect = prev.Slides, prev.Aspect

			// 슬라이드 구성은 2초마다(또는 장수가 바뀌면 즉시) 다시 확인한다.
			force := c.rescan.Swap(false)
			if force || st.PresPath != prev.PresPath || count != c.slideCt || c.pollN%5 == 0 {
				ids := make([]int, 0, count)
				var sb strings.Builder
				sb.WriteString(st.PresPath)
				for i := 1; i <= count; i++ {
					id := func() int {
						in := &scope{}
						defer in.close()
						sl, err := in.call(slides, "Item", i)
						if err != nil {
							return 0
						}
						id, _ := getInt(sl, "SlideID")
						return id
					}()
					ids = append(ids, id)
					sb.WriteString("|" + strconv.Itoa(id))
				}
				sig := sb.String()
				if force || sig != c.sig {
					if force || st.PresPath != prev.PresPath {
						c.thumbs = map[string][]byte{}
					}
					list := make([]SlideInfo, 0, count)
					for i := 1; i <= count; i++ {
						info := SlideInfo{ID: ids[i-1], Index: i}
						func() {
							in := &scope{}
							defer in.close()
							sl, err := in.call(slides, "Item", i)
							if err != nil {
								return
							}
							info.Title = slideTitle(sl)
							if tr, err := in.obj(sl, "SlideShowTransition"); err == nil {
								h, _ := getInt(tr, "Hidden")
								info.Hidden = h != 0
							}
						}()
						list = append(list, info)
					}
					st.Slides = list
					st.SlidesVer = prev.SlidesVer + 1
					st.Aspect = 16.0 / 9.0
					if ps, err := sc.obj(pres, "PageSetup"); err == nil {
						w, _ := getVal(ps, "SlideWidth")
						h, _ := getVal(ps, "SlideHeight")
						if toFloat(h) > 0 && toFloat(w) > 0 {
							st.Aspect = toFloat(w) / toFloat(h)
						}
					}
					c.sig = sig
					c.slideCt = count
				}
			}

			if view != nil {
				st.ShowRunning = true
				state, err := getInt(view, "State")
				if err != nil {
					return err
				}
				st.Black = state == ppShowBlack
				if sl, err := sc.obj(view, "Slide"); err == nil {
					st.CurID, _ = getInt(sl, "SlideID")
					st.CurIndex, _ = getInt(sl, "SlideIndex")
				}
				if x, err := callVal(view, "GetClickIndex"); err == nil {
					st.ClickIndex = toInt(x)
				}
				if x, err := callVal(view, "GetClickCount"); err == nil {
					st.ClickCount = toInt(x)
				}
			}
			return nil
		})
	})
	if err != nil && err != errNoApp {
		// 파워포인트가 잠깐 바쁠 때(대화상자·저장 중 등)는 직전 상태를 유지한다.
		c.fails++
		if c.fails < 8 {
			return
		}
	}
	c.fails = 0
	if !st.PresOpen {
		c.sig, c.slideCt = "", 0
		st.Slides = nil
		if prev.PresOpen {
			st.SlidesVer = prev.SlidesVer + 1
		}
	}
	c.publish(st)
}

// ---- 조작 ----------------------------------------------------------------

// inShow 는 실행 중인 슬라이드 쇼에서 fn 을 실행한다.
func inShow(fn func(sc *scope, pres, view *ole.IDispatch) error) error {
	return withApp(func(app *ole.IDispatch) error {
		sc := &scope{}
		defer sc.close()
		pres, view := target(sc, app)
		if pres == nil {
			return errNoPres
		}
		if view == nil {
			return errNoShow
		}
		return fn(sc, pres, view)
	})
}

func slideIndexByID(sc *scope, pres *ole.IDispatch, id int) (*ole.IDispatch, int, error) {
	slides, err := sc.obj(pres, "Slides")
	if err != nil {
		return nil, 0, err
	}
	sl, err := sc.call(slides, "FindBySlideID", id)
	if err != nil {
		return nil, 0, errNoSlide
	}
	idx, err := getInt(sl, "SlideIndex")
	if err != nil || idx < 1 {
		return nil, 0, errNoSlide
	}
	return sl, idx, nil
}

func (c *winController) Goto(id int) error {
	return c.do(func() error {
		return inShow(func(sc *scope, pres, view *ole.IDispatch) error {
			_, idx, err := slideIndexByID(sc, pres, id)
			if err != nil {
				return err
			}
			if state, _ := getInt(view, "State"); state != ppShowRunning {
				_ = putVal(view, "State", ppShowRunning)
			}
			return callVoid(view, "GotoSlide", idx)
		})
	})
}

func (c *winController) Step(dir int) error {
	return c.do(func() error {
		return inShow(func(sc *scope, pres, view *ole.IDispatch) error {
			ci, err1 := callVal(view, "GetClickIndex")
			cc, err2 := callVal(view, "GetClickCount")
			if err1 != nil || err2 != nil {
				return nil // 클릭 정보를 알 수 없으면 아무것도 하지 않는다 (다음 슬라이드로 넘어가면 안 됨)
			}
			if state, _ := getInt(view, "State"); state != ppShowRunning {
				_ = putVal(view, "State", ppShowRunning)
			}
			if dir > 0 && toInt(ci) < toInt(cc) {
				return callVoid(view, "Next")
			}
			if dir < 0 && toInt(ci) > 0 {
				return callVoid(view, "Previous")
			}
			return nil
		})
	})
}

func (c *winController) SetBlack(on bool) error {
	return c.do(func() error {
		return inShow(func(sc *scope, pres, view *ole.IDispatch) error {
			if on {
				return putVal(view, "State", ppShowBlack)
			}
			return putVal(view, "State", ppShowRunning)
		})
	})
}

func (c *winController) StartShow(id int) error {
	return c.do(func() error {
		return withApp(func(app *ole.IDispatch) error {
			sc := &scope{}
			defer sc.close()
			pres, view := target(sc, app)
			if pres == nil {
				return errNoPres
			}
			_, idx, err := slideIndexByID(sc, pres, id)
			if err != nil {
				return err
			}
			if view == nil {
				settings, err := sc.obj(pres, "SlideShowSettings")
				if err != nil {
					return err
				}
				win, err := sc.call(settings, "Run")
				if err != nil {
					return err
				}
				if view, err = sc.obj(win, "View"); err != nil {
					return err
				}
			}
			return callVoid(view, "GotoSlide", idx)
		})
	})
}

func (c *winController) Thumb(id int) ([]byte, error) {
	var out []byte
	err := c.do(func() error {
		return withApp(func(app *ole.IDispatch) error {
			sc := &scope{}
			defer sc.close()
			pres, _ := target(sc, app)
			if pres == nil {
				return errNoPres
			}
			key := getStr(pres, "FullName") + "|" + strconv.Itoa(id)
			if b, ok := c.thumbs[key]; ok {
				out = b
				return nil
			}
			sl, _, err := slideIndexByID(sc, pres, id)
			if err != nil {
				return err
			}
			aspect := 16.0 / 9.0
			if ps, err := sc.obj(pres, "PageSetup"); err == nil {
				w, _ := getVal(ps, "SlideWidth")
				h, _ := getVal(ps, "SlideHeight")
				if toFloat(h) > 0 && toFloat(w) > 0 {
					aspect = toFloat(w) / toFloat(h)
				}
			}
			tmp := filepath.Join(os.TempDir(), fmt.Sprintf("sermon-prompter-%d-%d.jpg", os.Getpid(), id))
			defer os.Remove(tmp)
			const width = 640
			if err := callVoid(sl, "Export", tmp, "JPG", width, int(float64(width)/aspect)); err != nil {
				return err
			}
			b, err := os.ReadFile(tmp)
			if err != nil {
				return err
			}
			c.thumbs[key] = b
			out = b
			return nil
		})
	})
	return out, err
}
