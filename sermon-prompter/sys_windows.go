//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func openBrowser(url string) {
	verb, _ := windows.UTF16PtrFromString("open")
	file, _ := windows.UTF16PtrFromString(url)
	_ = windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}

// addFirewallRule 은 관리자 권한 확인(UAC) 창을 한 번 띄운 뒤,
// 이 프로그램으로 들어오는 접속을 모든 네트워크 종류에서 허용한다.
func addFirewallRule() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := `advfirewall firewall add rule name="설교 프롬프터" dir=in action=allow program="` + exe + `" enable=yes profile=any`
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString("netsh.exe")
	argp, _ := windows.UTF16PtrFromString(args)
	return windows.ShellExecute(0, verb, file, argp, nil, windows.SW_HIDE)
}

const firewallHelper = true
