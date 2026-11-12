package main

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"sync"
)

// simController 는 파워포인트 없이 화면 흐름만 연습/개발할 때 쓰는 가상 PPT 이다.
// (-sim 옵션으로만 켜진다. 실제 예배 화면과는 연결되지 않는다.)
type simController struct {
	mu sync.Mutex
	st PptState
	ch chan struct{}
}

func newSimController() *simController {
	s := &simController{ch: make(chan struct{}, 1)}
	titles := []string{
		"예배 전 안내", "광고 1", "광고 2", "찬양 1", "찬양 2", "찬양 3", "기도", "성경 봉독",
		"와서 보라", "요한복음 1:43-46", "질문 셋", "미가 6:8", "복음이란", "칠판 설명", "드라마 대사", "결단",
		"헌금", "광고", "축도",
	}
	for i, t := range titles {
		s.st.Slides = append(s.st.Slides, SlideInfo{ID: 256 + i*3, Index: i + 1, Title: t})
	}
	s.st.AppRunning = true
	s.st.PresOpen = true
	s.st.PresName = "연습용 가상 예배.pptx"
	s.st.PresPath = "(연습용)/연습용 가상 예배.pptx"
	s.st.Aspect = 16.0 / 9.0
	s.st.SlidesVer = 1
	s.st.ShowRunning = true
	s.st.CurID = s.st.Slides[0].ID
	s.st.CurIndex = 1
	s.st.Simulated = true
	return s
}

func (s *simController) notify() {
	select {
	case s.ch <- struct{}{}:
	default:
	}
}

func (s *simController) State() PptState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.st
	st.Slides = append([]SlideInfo(nil), s.st.Slides...)
	return st
}

func (s *simController) Changes() <-chan struct{} { return s.ch }

func (s *simController) find(id int) *SlideInfo {
	for i := range s.st.Slides {
		if s.st.Slides[i].ID == id {
			return &s.st.Slides[i]
		}
	}
	return nil
}

func (s *simController) Goto(id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.st.ShowRunning {
		return errNoShow
	}
	sl := s.find(id)
	if sl == nil {
		return errNoSlide
	}
	s.st.CurID, s.st.CurIndex, s.st.Black = sl.ID, sl.Index, false
	s.notify()
	return nil
}

func (s *simController) Step(dir int) error { return nil }

func (s *simController) SetBlack(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.st.ShowRunning {
		return errNoShow
	}
	s.st.Black = on
	s.notify()
	return nil
}

func (s *simController) StartShow(id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sl := s.find(id)
	if sl == nil {
		return errNoSlide
	}
	s.st.ShowRunning = true
	s.st.CurID, s.st.CurIndex, s.st.Black = sl.ID, sl.Index, false
	s.notify()
	return nil
}

func (s *simController) Refresh() {
	s.mu.Lock()
	s.st.SlidesVer++
	s.mu.Unlock()
	s.notify()
}

// simCommand 는 개발·시험용으로 방송실의 수동 조작과 PPT 수정을 흉내 낸다.
func (s *simController) simCommand(cmd string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch cmd {
	case "manual": // 방송실에서 n번 슬라이드로 직접 넘김
		if n >= 1 && n <= len(s.st.Slides) {
			s.st.CurID, s.st.CurIndex, s.st.Black = s.st.Slides[n-1].ID, n, false
		}
	case "endshow":
		s.st.ShowRunning, s.st.CurID, s.st.CurIndex, s.st.Black = false, 0, 0, false
	case "insert": // 맨 앞에 광고 슬라이드 한 장 추가
		maxID := 0
		for _, sl := range s.st.Slides {
			if sl.ID > maxID {
				maxID = sl.ID
			}
		}
		s.st.Slides = append([]SlideInfo{{ID: maxID + 1, Title: "새 광고"}}, s.st.Slides...)
	case "delete": // n번 슬라이드 삭제
		if n >= 1 && n <= len(s.st.Slides) {
			s.st.Slides = append(s.st.Slides[:n-1:n-1], s.st.Slides[n:]...)
		}
	}
	for i := range s.st.Slides {
		s.st.Slides[i].Index = i + 1
	}
	if cmd == "insert" || cmd == "delete" {
		s.st.SlidesVer++
		if cur := s.find(s.st.CurID); cur != nil {
			s.st.CurIndex = cur.Index
		} else {
			s.st.CurID, s.st.CurIndex = 0, 0
		}
	}
	s.notify()
}

func (s *simController) Thumb(id int) ([]byte, error) {
	s.mu.Lock()
	sl := s.find(id)
	s.mu.Unlock()
	if sl == nil {
		return nil, errNoSlide
	}
	img := image.NewRGBA(image.Rect(0, 0, 320, 180))
	c := color.RGBA{uint8(40 + (sl.ID*37)%120), uint8(50 + (sl.ID*59)%120), uint8(90 + (sl.ID*83)%120), 255}
	draw.Draw(img, img.Bounds(), &image.Uniform{c}, image.Point{}, draw.Src)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
