//go:build !windows

package main

import "os/exec"

func newController(sim bool) Controller { return newSimController() }

func openBrowser(url string) { _ = exec.Command("xdg-open", url).Start() }

func addFirewallRule() error { return errUnsupport }

const firewallHelper = false
