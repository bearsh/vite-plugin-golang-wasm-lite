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

func ready() {
	expose(readyHint, true)
}

func expose(name string, value any) {
	GoWasm.Set(name, value)
}


func main() {
	fmt.Println("example math module")

	GoWasm.Set("add", js.FuncOf(func(this js.Value, args []js.Value) any {
		a := args[0].Int()
		b := args[1].Int()
		return a + b
	}))

	ready()
	select {}
}
