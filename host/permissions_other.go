//go:build !darwin

package main

import "time"

func requestAccessibility(time.Duration) bool { return false }

func requestScreenCapture() {}

var permissions []permission
