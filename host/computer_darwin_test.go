package main

import "testing"

func TestOnlyTextAnAppCouldCorrectIsPasted(t *testing.T) {
	for line, want := range map[string]bool{"pi eval 測試": true, "i think so": true, "中文": true, `say "hi"`: true, "a--b": true, "(37+45)*12=": false, "0912345678": false, "1,830": false, "": false} {
		if got := correctable(line); got != want {
			t.Errorf("correctable(%q) = %v, want %v", line, got, want)
		}
	}
}
