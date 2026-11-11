package main

import (
	"errors"
	"fmt"
	"image"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")
	imm32  = windows.NewLazySystemDLL("imm32.dll")

	immGetDefaultIMEWnd = imm32.NewProc("ImmGetDefaultIMEWnd")
	enumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	getMonitorInfo      = user32.NewProc("GetMonitorInfoW")
	sendMessageTimeout  = user32.NewProc("SendMessageTimeoutW")

	setDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	setProcessDPIAware     = user32.NewProc("SetProcessDPIAware")
	getSystemMetrics       = user32.NewProc("GetSystemMetrics")
	setCursorPos           = user32.NewProc("SetCursorPos")
	getCursorPos           = user32.NewProc("GetCursorPos")
	sendInput              = user32.NewProc("SendInput")
	mapVirtualKey          = user32.NewProc("MapVirtualKeyW")
	vkKeyScan              = user32.NewProc("VkKeyScanW")
	getDC                  = user32.NewProc("GetDC")
	releaseDC              = user32.NewProc("ReleaseDC")
	getWindowText          = user32.NewProc("GetWindowTextW")
	getWindowThreadProcess = user32.NewProc("GetWindowThreadProcessId")
	enumWindows            = user32.NewProc("EnumWindows")
	isWindowVisible        = user32.NewProc("IsWindowVisible")
	getWindow              = user32.NewProc("GetWindow")
	postMessage            = user32.NewProc("PostMessageW")
	openInputDesktop       = user32.NewProc("OpenInputDesktop")
	closeDesktop           = user32.NewProc("CloseDesktop")

	createCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	createCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	selectObject           = gdi32.NewProc("SelectObject")
	bitBlt                 = gdi32.NewProc("BitBlt")
	getDIBits              = gdi32.NewProc("GetDIBits")
	deleteObject           = gdi32.NewProc("DeleteObject")
	deleteDC               = gdi32.NewProc("DeleteDC")
)

const (
	perMonitorAwareV2 = ^uintptr(3)
	smCxScreen        = 0
	smCyScreen        = 1
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79
	srcCopy           = 0x00CC0020
	captureBlt        = 0x40000000
	gwOwner           = 4
	wmClose           = 0x0010
	desktopReadObject = 0x0001

	inputMouse    = 0
	inputKeyboard = 1

	mouseMove        = 0x0001
	mouseLeftDown    = 0x0002
	mouseLeftUp      = 0x0004
	mouseRightDown   = 0x0008
	mouseRightUp     = 0x0010
	mouseMiddleDown  = 0x0020
	mouseMiddleUp    = 0x0040
	mouseWheel       = 0x0800
	mouseHWheel      = 0x1000
	mouseAbsolute    = 0x8000
	mouseVirtualDesk = 0x4000
	wheelDelta       = 120

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyUnicode  = 0x0004
)

type mouseInput struct {
	dx, dy    int32
	mouseData uint32
	flags     uint32
	time      uint32
	extra     uintptr
}

type keyInput struct {
	vk, scan uint16
	flags    uint32
	time     uint32
	extra    uintptr
}

// why: INPUT is a C union; Go may drop the gaps between fields when it copies a struct, and the keyboard member's dwExtraInfo lies in a gap of the mouse member, so the union is plain bytes.
type inputRecord struct {
	_     [0]uint64
	kind  uint32
	_     uint32
	union [32]byte
}

func mouseRecord(m mouseInput) inputRecord {
	record := inputRecord{kind: inputMouse}
	*(*mouseInput)(unsafe.Pointer(&record.union)) = m
	return record
}

func keyRecord(k keyInput) inputRecord {
	record := inputRecord{kind: inputKeyboard}
	*(*keyInput)(unsafe.Pointer(&record.union)) = k
	return record
}

var winButtons = map[string][2]uint32{
	"left":   {mouseLeftDown, mouseLeftUp},
	"right":  {mouseRightDown, mouseRightUp},
	"middle": {mouseMiddleDown, mouseMiddleUp},
}

var namedKeys = map[string]uint16{
	"return": 0x0D, "enter": 0x0D, "tab": 0x09, "space": 0x20, "backspace": 0x08, "delete": 0x08, "esc": 0x1B, "escape": 0x1B,
	"forwarddelete": 0x2E, "insert": 0x2D, "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
	"left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
	"f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

var modifierKeys = map[string]uint16{
	"shift": 0xA0, "ctrl": 0xA2, "control": 0xA2, "alt": 0xA4, "option": 0xA4, "opt": 0xA4,
	"cmd": 0x5B, "command": 0x5B, "meta": 0x5B, "super": 0x5B, "win": 0x5B,
}

var extendedKeys = map[uint16]bool{0x2D: true, 0x2E: true, 0x24: true, 0x23: true, 0x21: true, 0x22: true, 0x25: true, 0x26: true, 0x27: true, 0x28: true, 0x5B: true}

type winScreen struct {
	mu   sync.Mutex
	held bool
}

var (
	errServiceSession = errors.New("pi-mobile runs as a Windows service here, which has no screen: tell the user to reinstall pi-mobile with install.ps1, which starts it when they sign in")
	errSecureDesktop  = errors.New("the computer's screen is locked, or Windows is showing a sign-in or administrator (UAC) prompt: nothing can see or use it until the user deals with it on the computer")
	errInputBlocked   = errors.New("Windows dropped the input: the window in front runs as administrator, or the screen is locked; tell the user to deal with that window on the computer")
)

func newScreen() (screen, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err == nil && session == 0 {
		return nil, errServiceSession
	}
	if setDpiAwarenessContext.Find() == nil {
		if ok, _, err := setDpiAwarenessContext.Call(perMonitorAwareV2); ok == 0 && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			setProcessDPIAware.Call()
		}
	} else {
		setProcessDPIAware.Call()
	}
	return &winScreen{}, nil
}

func inputDesktopReady() error {
	desktop, _, _ := openInputDesktop.Call(0, 0, desktopReadObject)
	if desktop == 0 {
		return errSecureDesktop
	}
	closeDesktop.Call(desktop)
	return nil
}

func screenSize() (int, int) {
	w, _, _ := getSystemMetrics.Call(smCxScreen)
	h, _, _ := getSystemMetrics.Call(smCyScreen)
	return int(int32(w)), int(int32(h))
}

type bitmapInfoHeader struct {
	size          uint32
	width, height int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPerMeter     int32
	yPerMeter     int32
	colorsUsed    uint32
	colorsImp     uint32
}

type monitorInfo struct {
	size          uint32
	monitor, work windows.Rect
	flags         uint32
}

const monitorPrimary = 1

var (
	monitorsMu    sync.Mutex
	monitorsFound []display
	monitorEach   = windows.NewCallback(func(monitor, _, _, _ uintptr) uintptr {
		info := monitorInfo{size: uint32(unsafe.Sizeof(monitorInfo{}))}
		if ok, _, _ := getMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ok != 0 {
			m := info.monitor
			d := display{float64(m.Left), float64(m.Top), float64(m.Right - m.Left), float64(m.Bottom - m.Top)}
			if info.flags&monitorPrimary != 0 {
				monitorsFound = append([]display{d}, monitorsFound...)
			} else {
				monitorsFound = append(monitorsFound, d)
			}
		}
		return 1
	})
)

func (s *winScreen) displays() ([]display, error) {
	monitorsMu.Lock()
	defer monitorsMu.Unlock()
	monitorsFound = nil
	enumDisplayMonitors.Call(0, 0, monitorEach, 0)
	if len(monitorsFound) > 0 {
		return monitorsFound, nil
	}
	width, height := screenSize()
	if width <= 0 || height <= 0 {
		return nil, errors.New("Windows reports no screen")
	}
	return []display{{0, 0, float64(width), float64(height)}}, nil
}

func (s *winScreen) capture(d display) (image.Image, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := inputDesktopReady(); err != nil {
		return nil, err
	}
	width, height := int(d.w), int(d.h)
	screenDC, _, _ := getDC.Call(0)
	if screenDC == 0 {
		return nil, errors.New("Windows gave no screen to capture")
	}
	defer releaseDC.Call(0, screenDC)
	memoryDC, _, _ := createCompatibleDC.Call(screenDC)
	defer deleteDC.Call(memoryDC)
	bitmap, _, _ := createCompatibleBitmap.Call(screenDC, uintptr(width), uintptr(height))
	if bitmap == 0 {
		return nil, errors.New("Windows could not make a bitmap for the screenshot")
	}
	defer deleteObject.Call(bitmap)
	previous, _, _ := selectObject.Call(memoryDC, bitmap)
	if ok, _, err := bitBlt.Call(memoryDC, 0, 0, uintptr(width), uintptr(height), screenDC, uintptr(int(d.x)), uintptr(int(d.y)), srcCopy|captureBlt); ok == 0 {
		selectObject.Call(memoryDC, previous)
		return nil, fmt.Errorf("screenshot: %w", err)
	}
	selectObject.Call(memoryDC, previous)
	header := bitmapInfoHeader{width: int32(width), height: -int32(height), planes: 1, bitCount: 32}
	header.size = uint32(unsafe.Sizeof(header))
	pixels := make([]byte, width*height*4)
	if lines, _, err := getDIBits.Call(memoryDC, bitmap, 0, uintptr(height), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&header)), 0); lines == 0 {
		return nil, fmt.Errorf("screenshot: %w", err)
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < len(pixels); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = pixels[i+2], pixels[i+1], pixels[i], 0xff
	}
	return img, nil
}

func windowTitle(window uintptr) string {
	buffer := make([]uint16, 512)
	n, _, _ := getWindowText.Call(window, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	return syscall.UTF16ToString(buffer[:n])
}

func windowProcess(window uintptr) int {
	var pid uint32
	getWindowThreadProcess.Call(window, uintptr(unsafe.Pointer(&pid)))
	return int(pid)
}

func exeName(pid int) string {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(process)
	buffer := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(process, 0, &buffer[0], &size) != nil {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(syscall.UTF16ToString(buffer[:size])), ".exe")
}

func (s *winScreen) state() (string, string, float64, float64) {
	var at struct{ X, Y int32 }
	getCursorPos.Call(uintptr(unsafe.Pointer(&at)))
	front := uintptr(windows.GetForegroundWindow())
	if front == 0 {
		return "", "", float64(at.X), float64(at.Y)
	}
	return exeName(windowProcess(front)), windowTitle(front), float64(at.X), float64(at.Y)
}

func topWindows() map[uintptr]int {
	found := map[uintptr]int{}
	callback := windows.NewCallback(func(window, _ uintptr) uintptr {
		visible, _, _ := isWindowVisible.Call(window)
		owner, _, _ := getWindow.Call(window, gwOwner)
		if visible != 0 && owner == 0 && windowTitle(window) != "" {
			found[window] = windowProcess(window)
		}
		return 1
	})
	enumWindows.Call(callback, 0)
	return found
}

var keptRunning = map[string]bool{"explorer": true, "ApplicationFrameHost": true, "pi-mobile": true}

func (s *winScreen) apps() map[int]string {
	apps := map[int]string{}
	for _, pid := range topWindows() {
		if name := exeName(pid); name != "" && !keptRunning[name] {
			apps[pid] = name
		}
	}
	return apps
}

func (s *winScreen) quit(pids []int) {
	closing := map[int]bool{}
	for _, pid := range pids {
		closing[pid] = true
	}
	for window, pid := range topWindows() {
		if closing[pid] {
			postMessage.Call(window, wmClose, 0, 0)
		}
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	for _, pid := range pids {
		process, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
		if err != nil {
			continue
		}
		wait := max(time.Until(deadline), 0)
		if event, _ := windows.WaitForSingleObject(process, uint32(wait.Milliseconds())); event != windows.WAIT_OBJECT_0 {
			_ = windows.TerminateProcess(process, 1)
		}
		windows.CloseHandle(process)
	}
}

func send(records []inputRecord) error {
	if len(records) == 0 {
		return nil
	}
	if err := inputDesktopReady(); err != nil {
		return err
	}
	sent, _, _ := sendInput.Call(uintptr(len(records)), uintptr(unsafe.Pointer(&records[0])), unsafe.Sizeof(records[0]))
	if int(sent) != len(records) {
		return errInputBlocked
	}
	return nil
}

func moveCursor(x, y float64) error {
	if err := inputDesktopReady(); err != nil {
		return err
	}
	if ok, _, err := setCursorPos.Call(uintptr(int(math.Round(x))), uintptr(int(math.Round(y)))); ok == 0 {
		return fmt.Errorf("move the pointer: %w", err)
	}
	return nil
}

func (s *winScreen) pointer(x, y float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.held {
		return moveCursor(x, y)
	}
	return send([]inputRecord{mouseRecord(absolute(x, y))})
}

func (s *winScreen) button(name string, down bool, _ int) error {
	flags, ok := winButtons[name]
	if !ok {
		return fmt.Errorf("unknown button %q", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	edge := flags[1]
	if down {
		edge = flags[0]
	}
	if err := send([]inputRecord{mouseRecord(mouseInput{flags: edge})}); err != nil {
		return err
	}
	s.held = down
	return nil
}

func absolute(x, y float64) mouseInput {
	metric := func(index uintptr) float64 {
		value, _, _ := getSystemMetrics.Call(index)
		return float64(int32(value))
	}
	left, top, width, height := metric(smXVirtualScreen), metric(smYVirtualScreen), metric(smCxVirtualScreen), metric(smCyVirtualScreen)
	return mouseInput{
		dx:    int32(math.Round((x - left) * 65535 / max(width-1, 1))),
		dy:    int32(math.Round((y - top) * 65535 / max(height-1, 1))),
		flags: mouseMove | mouseAbsolute | mouseVirtualDesk,
	}
}

func (s *winScreen) wheel(dx, dy int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := []inputRecord{}
	if dy != 0 {
		records = append(records, mouseRecord(mouseInput{flags: mouseWheel, mouseData: uint32(int32(-dy * wheelDelta))}))
	}
	if dx != 0 {
		records = append(records, mouseRecord(mouseInput{flags: mouseHWheel, mouseData: uint32(int32(dx * wheelDelta))}))
	}
	if len(records) == 0 {
		return nil
	}
	return send(records)
}

func virtualKey(name string) (vk uint16, shift bool, ok bool) {
	if vk, ok := namedKeys[name]; ok {
		return vk, false, true
	}
	if vk, ok := modifierKeys[name]; ok {
		return vk, false, true
	}
	runes := []rune(name)
	if len(runes) != 1 {
		return 0, false, false
	}
	r := runes[0]
	switch {
	case r >= 'a' && r <= 'z':
		return uint16(r - 'a' + 'A'), false, true
	case r >= '0' && r <= '9':
		return uint16(r), false, true
	case r > 0xffff:
		return 0, false, false
	}
	scan, _, _ := vkKeyScan.Call(uintptr(r))
	if int16(scan) == -1 {
		return 0, false, false
	}
	return uint16(scan & 0xff), scan&0x100 != 0, true
}

func keyStroke(vk uint16, up bool) inputRecord {
	scan, _, _ := mapVirtualKey.Call(uintptr(vk), 0)
	flags := uint32(0)
	if extendedKeys[vk] {
		flags |= keyExtended
	}
	if up {
		flags |= keyUp
	}
	return keyRecord(keyInput{vk: vk, scan: uint16(scan), flags: flags})
}

func (s *winScreen) press(name string, down bool) error {
	vk, shift, ok := virtualKey(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records := []inputRecord{keyStroke(vk, !down)}
	if shift && down {
		records = append([]inputRecord{keyStroke(modifierKeys["shift"], false)}, records...)
	}
	if shift && !down {
		records = append(records, keyStroke(modifierKeys["shift"], true))
	}
	return send(records)
}

func tapRecords(vk uint16) []inputRecord {
	return []inputRecord{keyStroke(vk, false), keyStroke(vk, true)}
}

func textRecords(text string) [][]inputRecord {
	chunks := [][]inputRecord{}
	for _, r := range strings.ReplaceAll(text, "\r\n", "\n") {
		switch r {
		case '\n', '\r':
			chunks = append(chunks, tapRecords(namedKeys["return"]))
		case '\t':
			chunks = append(chunks, tapRecords(namedKeys["tab"]))
		default:
			chunk := []inputRecord{}
			for _, unit := range utf16.Encode([]rune{r}) {
				chunk = append(chunk, keyRecord(keyInput{scan: unit, flags: keyUnicode}), keyRecord(keyInput{scan: unit, flags: keyUnicode | keyUp}))
			}
			chunks = append(chunks, chunk)
		}
	}
	return chunks
}

func (s *winScreen) holdClipboard() (func() error, error) {
	var saved []clipItem
	if err := withClipboard(func() error { saved = clipboardItems(); return nil }); err != nil {
		return nil, err
	}
	return func() error { return withClipboard(func() error { return writeClipboard(saved) }) }, nil
}

func (s *winScreen) putClipboard(text string) error {
	return withClipboard(func() error { return writeClipboard([]clipItem{textItem(text)}) })
}

func (s *winScreen) pasteKeys() string { return "ctrl+v" }

func (s *winScreen) typeRunes(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return withInputMethodClosed(func() error {
		for _, chunk := range textRecords(text) {
			if err := send(chunk); err != nil {
				return err
			}
			// why: Windows 11 Notepad dropped or repeated characters sent faster; 8 ms still lost one in 8 lines, 15 ms none in 10
			time.Sleep(keyPace)
		}
		return nil
	})
}

const (
	wmIMEControl     = 0x0283
	imcGetOpenStatus = 0x0005
	imcSetOpenStatus = 0x0006
	smtoAbortIfHung  = 0x0002
	inputSettle      = 50 * time.Millisecond
	inputDrain       = 300 * time.Millisecond
	keyPace          = 15 * time.Millisecond
)

func focusedWindow() uintptr {
	info := windows.GUIThreadInfo{Size: uint32(unsafe.Sizeof(windows.GUIThreadInfo{}))}
	if windows.GetGUIThreadInfo(0, &info) == nil && info.Focus != 0 {
		return uintptr(info.Focus)
	}
	return uintptr(windows.GetForegroundWindow())
}

func inputMethod(ime, command, value uintptr) uintptr {
	var result uintptr
	sendMessageTimeout.Call(ime, wmIMEControl, command, value, smtoAbortIfHung, 200, uintptr(unsafe.Pointer(&result)))
	return result
}

// why: an open Chinese or Japanese input method composes typed characters instead of inserting them, so the next return only confirms them
func withInputMethodClosed(typing func() error) error {
	ime, _, _ := immGetDefaultIMEWnd.Call(focusedWindow())
	if ime == 0 || inputMethod(ime, imcGetOpenStatus, 0) == 0 {
		return typing()
	}
	inputMethod(ime, imcSetOpenStatus, 0)
	// why: the input method takes effect a moment after the call and the app reads typed keys after SendInput returns; keys sent while it is open get composed
	time.Sleep(inputSettle)
	err := typing()
	time.Sleep(inputDrain)
	inputMethod(ime, imcSetOpenStatus, 1)
	return err
}
