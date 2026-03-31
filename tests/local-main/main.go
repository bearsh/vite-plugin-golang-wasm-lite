package main

import (
	"fmt"
	"syscall/js"
)

const (
	goWasmName = "__go_wasm__"
	readyHint  = "__ready__"
)

var (
	Global = js.Global()
	GoWasm = Global.Get(goWasmName)
)

func Ready() {
	Expose(readyHint, true)
}

func Expose(name string, value any) {
	GoWasm.Set(name, value)
}

func main() {
	Ready()

	fmt.Println("Hello WASM")
}
