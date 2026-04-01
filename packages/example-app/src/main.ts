// either import from a source directory
import goMath from 'go:./math'
// or from a remote module (with optional version)
//import goMath from 'go:github.com/bearsh/vite-plugin-golang-wasm-lite/packages/example-app/src/math@latest'

import './demo.css';

const el = document.getElementById('app');
if (el) {
  el.innerHTML = `
    <div id="app-demo">
      <h1>Vite + Go WASM Demo</h1>
      <p>The Go function <code>add(1, 2)</code> was successfully imported and executed:</p>
      <div class="result-box">
        <span class="result-label">Result:</span>
        <span class="result-value">${goMath.add(1, 2)}</span>
      </div>
      <p class="powered">powered by <b>vite-plugin-golang-wasm-lite</b></p>
    </div>
  `;
}
