//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW prevents a Windows console-subsystem child from receiving
// a new conhost.exe when it is launched with redirected standard streams.
const createNoWindow = 0x08000000

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "agy-headless: missing target executable")
		os.Exit(64)
	}

	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNoWindow,
		HideWindow:    true,
	}

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "agy-headless: failed to start target: %v\n", err)
		os.Exit(1)
	}
}
