package main

import (
	"testing"
	"unsafe"
)

func TestInputRecordIsTheSizeOfWindowsINPUT(t *testing.T) {
	if size, union := unsafe.Sizeof(inputRecord{}), unsafe.Offsetof(inputRecord{}.union); size != 40 || union != 8 {
		t.Fatalf("INPUT is 40 bytes with its union at 8 on 64-bit Windows, inputRecord is %d with it at %d", size, union)
	}
}

func TestTextRecordsSendUnicodeUnitsAndRealTab(t *testing.T) {
	var keys []keyInput
	for _, chunk := range textRecords("a中\t😀") {
		for _, record := range chunk {
			keys = append(keys, *(*keyInput)(unsafe.Pointer(&record.union)))
		}
	}
	want := []keyInput{
		{scan: 'a', flags: keyUnicode}, {scan: 'a', flags: keyUnicode | keyUp},
		{scan: 0x4e2d, flags: keyUnicode}, {scan: 0x4e2d, flags: keyUnicode | keyUp},
		{vk: 0x09, flags: 0}, {vk: 0x09, flags: keyUp},
		{scan: 0xd83d, flags: keyUnicode}, {scan: 0xd83d, flags: keyUnicode | keyUp},
		{scan: 0xde00, flags: keyUnicode}, {scan: 0xde00, flags: keyUnicode | keyUp},
	}
	if len(keys) != len(want) {
		t.Fatalf("got %d key events, want %d", len(keys), len(want))
	}
	for i := range want {
		got := keys[i]
		if got.vk == 0x09 {
			got.scan = 0
		}
		if got != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, got, want[i])
		}
	}
}

func TestTextRecordsSendOneCharacterAtATime(t *testing.T) {
	if chunks := textRecords("Hello pi 123, IME test!\t中😀"); len(chunks) != 26 {
		t.Fatalf("got %d chunks, want one per character (26): an app that falls behind a batch drops or repeats its characters", len(chunks))
	}
}

func TestTextRecordsNeverSplitASurrogatePair(t *testing.T) {
	for _, chunk := range textRecords("😀😀😀😀😀😀😀😀😀😀") {
		first := *(*keyInput)(unsafe.Pointer(&chunk[0].union))
		if first.scan == 0xde00 {
			t.Fatal("a chunk starts with the low half of a surrogate pair")
		}
	}
}

func TestACOMCallOnNothingFailsInsteadOfCrashing(t *testing.T) {
	if got := comCall(0, rangeMoveByUnit, 0); got != pointerMissing {
		t.Fatalf("comCall on a nil object = %#x, want E_POINTER", got)
	}
	var f focus
	readText(0, &f)
	if f.end != "" {
		t.Fatalf("reading no text gave %q", f.end)
	}
}
