package main

import (
	"errors"
	"runtime"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type clipboardItem struct {
	types []string
	data  [][]byte
}

type pasteboard struct {
	general, string, data, poolClass, item, mutableArray objc.ID
	sel                                                  map[string]objc.SEL
}

const nsUTF8 = 4

func newPasteboard() (*pasteboard, error) {
	if _, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
		return nil, err
	}
	p := &pasteboard{sel: map[string]objc.SEL{}}
	for _, name := range []string{"generalPasteboard", "pasteboardItems", "count", "objectAtIndex:", "types", "dataForType:", "length", "bytes",
		"UTF8String", "lengthOfBytesUsingEncoding:", "stringWithUTF8String:", "dataWithBytes:length:", "alloc", "init", "new", "drain",
		"clearContents", "setData:forType:", "addObject:", "writeObjects:", "setString:forType:", "release"} {
		p.sel[name] = objc.RegisterName(name)
	}
	p.general = objc.ID(objc.GetClass("NSPasteboard")).Send(p.sel["generalPasteboard"])
	p.string, p.data, p.poolClass = objc.ID(objc.GetClass("NSString")), objc.ID(objc.GetClass("NSData")), objc.ID(objc.GetClass("NSAutoreleasePool"))
	p.item, p.mutableArray = objc.ID(objc.GetClass("NSPasteboardItem")), objc.ID(objc.GetClass("NSMutableArray"))
	if p.general == 0 || p.string == 0 || p.item == 0 {
		return nil, errors.New("AppKit has no general pasteboard")
	}
	return p, nil
}

func (p *pasteboard) pooled(work func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := p.poolClass.Send(p.sel["new"])
	defer pool.Send(p.sel["drain"])
	work()
}

func (p *pasteboard) goString(value objc.ID) string {
	if value == 0 {
		return ""
	}
	size := objc.Send[uint64](value, p.sel["lengthOfBytesUsingEncoding:"], uint64(nsUTF8))
	text := objc.Send[*byte](value, p.sel["UTF8String"])
	if text == nil || size == 0 {
		return ""
	}
	return string(unsafe.Slice(text, size))
}

func (p *pasteboard) nsString(text string) objc.ID {
	return p.string.Send(p.sel["stringWithUTF8String:"], text)
}

func (p *pasteboard) save() []clipboardItem {
	var saved []clipboardItem
	p.pooled(func() {
		items := p.general.Send(p.sel["pasteboardItems"])
		for i := range objc.Send[uint64](items, p.sel["count"]) {
			item := items.Send(p.sel["objectAtIndex:"], i)
			types := item.Send(p.sel["types"])
			kept := clipboardItem{}
			for j := range objc.Send[uint64](types, p.sel["count"]) {
				kind := types.Send(p.sel["objectAtIndex:"], j)
				data := item.Send(p.sel["dataForType:"], kind)
				if data == 0 {
					continue
				}
				size := objc.Send[uint64](data, p.sel["length"])
				bytes := []byte{}
				if size > 0 {
					bytes = append(bytes, unsafe.Slice(objc.Send[*byte](data, p.sel["bytes"]), size)...)
				}
				kept.types = append(kept.types, p.goString(kind))
				kept.data = append(kept.data, bytes)
			}
			saved = append(saved, kept)
		}
	})
	return saved
}

func (p *pasteboard) restore(saved []clipboardItem) {
	p.pooled(func() {
		p.general.Send(p.sel["clearContents"])
		if len(saved) == 0 {
			return
		}
		items := p.mutableArray.Send(p.sel["new"])
		for _, kept := range saved {
			item := p.item.Send(p.sel["new"])
			for i, kind := range kept.types {
				var start unsafe.Pointer
				if len(kept.data[i]) > 0 {
					start = unsafe.Pointer(&kept.data[i][0])
				}
				data := p.data.Send(p.sel["dataWithBytes:length:"], start, uint64(len(kept.data[i])))
				item.Send(p.sel["setData:forType:"], data, p.nsString(kind))
			}
			items.Send(p.sel["addObject:"], item)
			item.Send(p.sel["release"])
		}
		p.general.Send(p.sel["writeObjects:"], items)
		items.Send(p.sel["release"])
	})
}

func (p *pasteboard) setText(text string) {
	p.pooled(func() {
		p.general.Send(p.sel["clearContents"])
		p.general.Send(p.sel["setString:forType:"], p.nsString(text), p.nsString("public.utf8-plain-text"))
	})
}
