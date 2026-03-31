import goMath from './math/math.go'


const el = document.getElementById('app')
if (el) el.innerHTML = `- Example app started<br>- go file imported<br>- call function <code>add(1, 2)</code><br>- result: <code>${goMath.add(1, 2)}</code>`
