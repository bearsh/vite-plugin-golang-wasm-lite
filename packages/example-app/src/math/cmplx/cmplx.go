package main

import (
	"fmt"
	"math/cmplx"
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
	fmt.Println("example cmplx module")

	GoWasm.Set("abs", js.FuncOf(func(this js.Value, args []js.Value) any {
		a := args[0].Float()
		b := args[1].Float()
		return cmplx.Abs(complex(a, b))
	}))

	ready()
	select {}
}
