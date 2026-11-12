package main

import "errors"

// SlideInfo 는 열려 있는 PPT 의 슬라이드 한 장을 설명한다.
// ID 는 파워포인트의 SlideID 로, 슬라이드를 앞뒤로 옮기거나 다른 슬라이드를
// 끼워 넣어도 바뀌지 않는다. Index 는 현재 순서(1부터)이다.
type SlideInfo struct {
	ID     int    `json:"id"`
	Index  int    `json:"index"`
	Title  string `json:"title"`
	Hidden bool   `json:"hidden"`
}

// PptState 는 파워포인트의 현재 상태를 찍은 스냅숏이다.
type PptState struct {
	AppRunning  bool        `json:"appRunning"`  // 파워포인트 실행 여부
	PresOpen    bool        `json:"presOpen"`    // 열린 프레젠테이션 여부
	PresName    string      `json:"presName"`    // 파일 이름
	PresPath    string      `json:"presPath"`    // 전체 경로
	Aspect      float64     `json:"aspect"`      // 가로/세로 비율
	Slides      []SlideInfo `json:"slides"`      //
	SlidesVer   int         `json:"slidesVer"`   // 슬라이드 목록/미리보기가 바뀔 때 증가
	ShowRunning bool        `json:"showRunning"` // 슬라이드 쇼 실행 여부
	CurID       int         `json:"curId"`       // 송출 중인 슬라이드 ID (없으면 0)
	CurIndex    int         `json:"curIndex"`    // 송출 중인 슬라이드 번호
	Black       bool        `json:"black"`       // 검은 화면 여부
	ClickIndex  int         `json:"clickIndex"`  // 현재 슬라이드에서 진행한 클릭 애니메이션 수
	ClickCount  int         `json:"clickCount"`  // 현재 슬라이드의 클릭 애니메이션 총수
	Simulated   bool        `json:"simulated"`   // 연습용 가상 PPT 여부
}

var (
	errNoApp      = errors.New("파워포인트가 실행되어 있지 않습니다")
	errNoPres     = errors.New("열려 있는 PPT 파일이 없습니다")
	errNoShow     = errors.New("슬라이드 쇼가 실행 중이 아닙니다")
	errNoSlide    = errors.New("PPT 에서 해당 슬라이드를 찾을 수 없습니다")
	errNotInShow  = errors.New("슬라이드 쇼가 끝난 상태입니다")
	errUnsupport  = errors.New("이 컴퓨터에서는 지원하지 않는 기능입니다")
	errBusy       = errors.New("파워포인트가 응답하지 않습니다. 열려 있는 대화상자가 있는지 확인해 주세요")
	_, _, _, _, _ = errNoApp, errNotInShow, errUnsupport, errBusy, errNoShow
)

// Controller 는 파워포인트(또는 연습용 가상 PPT)를 조작한다.
type Controller interface {
	// State 는 가장 최근 스냅숏을 돌려준다.
	State() PptState
	// Changes 는 상태가 바뀔 때마다 신호를 보낸다.
	Changes() <-chan struct{}
	// Goto 는 슬라이드 쇼를 해당 슬라이드로 옮긴다. 검은 화면이면 해제한다.
	Goto(slideID int) error
	// Step 은 현재 슬라이드 안에서 클릭 애니메이션을 한 단계 진행(+1)/되돌림(-1)한다.
	Step(dir int) error
	// SetBlack 은 현재 슬라이드를 유지한 채 송출 화면만 검게 가리거나 되돌린다.
	SetBlack(on bool) error
	// StartShow 는 슬라이드 쇼를 시작하고 해당 슬라이드를 띄운다.
	StartShow(slideID int) error
	// Thumb 은 슬라이드 미리보기(JPEG)를 돌려준다.
	Thumb(slideID int) ([]byte, error)
	// Refresh 는 슬라이드 목록과 미리보기를 다시 읽는다.
	Refresh()
}
