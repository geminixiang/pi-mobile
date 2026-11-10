package main

import (
	"testing"
	"unsafe"
)

func TestInputRecordIsTheSizeOfWindowsINPUT(t *testing.T) {
	if size := unsafe.Sizeof(inputRecord{}); size != 40 {
		t.Fatalf("INPUT is 40 bytes on 64-bit Windows, inputRecord is %d", size)
	}
}

func TestTextRecordsSendUnicodeUnitsAndRealEnter(t *testing.T) {
	var keys []keyInput
	for _, chunk := range textRecords("a中\r\n😀") {
		for _, record := range chunk {
			keys = append(keys, *(*keyInput)(unsafe.Pointer(&record.mouse)))
		}
	}
	want := []keyInput{
		{scan: 'a', flags: keyUnicode}, {scan: 'a', flags: keyUnicode | keyUp},
		{scan: 0x4e2d, flags: keyUnicode}, {scan: 0x4e2d, flags: keyUnicode | keyUp},
		{vk: 0x0D, flags: 0}, {vk: 0x0D, flags: keyUp},
		{scan: 0xd83d, flags: keyUnicode}, {scan: 0xd83d, flags: keyUnicode | keyUp},
		{scan: 0xde00, flags: keyUnicode}, {scan: 0xde00, flags: keyUnicode | keyUp},
	}
	if len(keys) != len(want) {
		t.Fatalf("got %d key events, want %d", len(keys), len(want))
	}
	for i := range want {
		got := keys[i]
		if got.vk == 0x0D {
			got.scan = 0
		}
		if got != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, got, want[i])
		}
	}
}

func TestTextRecordsNeverSplitASurrogatePair(t *testing.T) {
	for _, chunk := range textRecords("😀😀😀😀😀😀😀😀😀😀") {
		first := *(*keyInput)(unsafe.Pointer(&chunk[0].mouse))
		if first.scan == 0xde00 {
			t.Fatal("a chunk starts with the low half of a surrogate pair")
		}
	}
}
