package main

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
)

// Config 는 이 컴퓨터에 한 번 정해지면 계속 유지되는 설정이다.
// 포트와 연결 키가 유지되므로, 태블릿에 저장해 둔 주소가 다음 주에도 그대로 쓰인다.
type Config struct {
	Token string `json:"token"`
	Dept  string `json:"dept"`
	Port  int    `json:"port"`
}

const tokenAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

func newToken() string {
	b := make([]byte, 14)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = tokenAlphabet[int(b[i])%len(tokenAlphabet)]
	}
	return string(b)
}

func readJSON(path string, v interface{}) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// writeJSON 은 임시 파일에 쓴 뒤 바꿔치기해서, 저장 도중 꺼져도 기존 파일이 깨지지 않게 한다.
func writeJSON(path string, v interface{}) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func defaultDataDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir, _ = os.Getwd()
	}
	return filepath.Join(dir, "SermonPrompter")
}
