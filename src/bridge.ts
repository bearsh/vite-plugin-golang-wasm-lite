const g =
  typeof globalThis !== "undefined" ? globalThis :
  typeof global !== "undefined" ? global :
  typeof window !== "undefined" ? window :
  self

// @ts-expect-error
if(typeof Go == 'undefined')
  throw new Error("Golang wasm_exec should be initialized first")

// @ts-expect-error
if(typeof __go_wasm__ == "undefined") {
  // @ts-expect-error
  g.__go_wasm__ = {}
}

// @ts-expect-error
const bridge = __go_wasm__ as any

export default async function (bytes: BufferSource | Promise<BufferSource>) {
  // @ts-expect-error
  const go = new Go()
  const result = await WebAssembly.instantiate(await bytes, go.importObject)
  bridge.__instance__ = result.instance
  go.run(result.instance)

  setTimeout(() => {
    if (bridge.__ready__ !== true) {
      console.warn(
        'Golang WASM Bridge (__go_wasm__.__ready__) still not true after max time'
      )
    }
  }, 3 * 1000)

  while (bridge.__ready__ !== true) {
    await new Promise<void>(res => setTimeout(res, 16))
  }

  return new Proxy({}, {
    get(_, key) {
      // here we can handle special properties if we would ever like
      return bridge[key]
    },
  })
}
