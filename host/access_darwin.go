// Asking macOS for Accessibility and Screen Recording the way an app does, so pi-mobile is added to their lists in
// System Settings, with its name and icon, and the user is asked; checking alone (AXIsProcessTrusted) never adds it.
// docs/research/macos-automation.md.
package main

import (
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

type access struct {
	axTrusted        func() bool
	axTrustedOptions func(uintptr) bool
	screenPreflight  func() bool
	screenRequest    func() bool
	dictionary       func(uintptr, *uintptr, *uintptr, int, uintptr, uintptr) uintptr
	release          func(uintptr)
	promptKey        uintptr
	booleanTrue      uintptr
	keyCallBacks     uintptr
	valueCallBacks   uintptr
}

func loadAccess() (*access, error) {
	services, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	foundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	a := &access{}
	purego.RegisterLibFunc(&a.axTrusted, services, "AXIsProcessTrusted")
	purego.RegisterLibFunc(&a.axTrustedOptions, services, "AXIsProcessTrustedWithOptions")
	purego.RegisterLibFunc(&a.screenPreflight, services, "CGPreflightScreenCaptureAccess")
	purego.RegisterLibFunc(&a.screenRequest, services, "CGRequestScreenCaptureAccess")
	purego.RegisterLibFunc(&a.dictionary, foundation, "CFDictionaryCreate")
	purego.RegisterLibFunc(&a.release, foundation, "CFRelease")
	// Globals: the symbol is the variable's address; the CFTypeRefs are read from it, the callback structs passed as is.
	read := func(lib uintptr, name string) (uintptr, error) {
		address, err := purego.Dlsym(lib, name)
		if err != nil {
			return 0, err
		}
		// The address seen as a pointer to the variable (vet allows converting the pointer to it, not the uintptr).
		return **(**uintptr)(unsafe.Pointer(&address)), nil
	}
	if a.promptKey, err = read(services, "kAXTrustedCheckOptionPrompt"); err != nil {
		return nil, err
	}
	if a.booleanTrue, err = read(foundation, "kCFBooleanTrue"); err != nil {
		return nil, err
	}
	if a.keyCallBacks, err = purego.Dlsym(foundation, "kCFTypeDictionaryKeyCallBacks"); err != nil {
		return nil, err
	}
	if a.valueCallBacks, err = purego.Dlsym(foundation, "kCFTypeDictionaryValueCallBacks"); err != nil {
		return nil, err
	}
	return a, nil
}

// requestAccessibility asks for Accessibility unless it is granted, and waits up to `wait` for the user to turn it on:
// the system's question is asynchronous, and the grant applies to the running process.
func requestAccessibility(wait time.Duration) bool {
	a, err := loadAccess()
	if err != nil {
		return false
	}
	if a.axTrusted() {
		return true
	}
	key, value := a.promptKey, a.booleanTrue
	options := a.dictionary(0, &key, &value, 1, a.keyCallBacks, a.valueCallBacks)
	a.axTrustedOptions(options)
	a.release(options)
	for deadline := time.Now().Add(wait); time.Now().Before(deadline); time.Sleep(time.Second) {
		if a.axTrusted() {
			return true
		}
	}
	return false
}

// requestScreenCapture asks for Screen Recording unless it is granted. A grant applies only to processes started
// after it, so false here may still be granted by the next start.
func requestScreenCapture() bool {
	a, err := loadAccess()
	if err != nil {
		return false
	}
	return a.screenPreflight() || a.screenRequest()
}
