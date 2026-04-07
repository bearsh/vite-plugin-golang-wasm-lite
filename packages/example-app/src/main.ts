// either import from a source directory
import goMath from 'go:./math'
import goMathCmplx from 'go:./math/cmplx'
// or from a remote module (with optional version)
//import goMath from 'go:github.com/bearsh/vite-plugin-golang-wasm-lite/packages/example-app/src/math@258fafb'
//import goMathCmplx from 'go:github.com/bearsh/vite-plugin-golang-wasm-lite/packages/example-app/src/math/cmplx@258fafb'

import './demo.css';

const el = document.getElementById('app');
if (el) {
  el.innerHTML = `
    <div id="app-demo">
      <h1>Vite + Go WASM Demo</h1>
      <p>The Go function <code>add(1, 2)</code> was successfully imported and executed from the example <code>math</code> module:</p>
      <div class="result-box">
        <span class="result-label">Result:</span>
        <span class="result-value">${goMath.add(1, 2)}</span>
      </div>
      <p>The Go function <code>abs(37.56, 21.25)</code> was successfully imported and executed from the example <code>math/cmplx</code> module:</p>
      <div class="result-box">
        <span class="result-label">Result:</span>
        <span class="result-value">${goMathCmplx.abs(37.56, 21.25)}</span>
      </div>
      <p class="powered">powered by <b>vite-plugin-golang-wasm-lite</b></p>
    </div>
  `;
}
