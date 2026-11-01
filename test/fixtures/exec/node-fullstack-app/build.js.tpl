'use strict';
// A deterministic build: dist/index.html, the page of the notes app (it talks to the API of the same process).
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<title>notes</title>
<h1>Notes</h1>
<form id="f"><input id="t" placeholder="a note" required><button>Add</button></form>
<ul id="list"></ul>
<script>
async function load() {
  const rows = await (await fetch('/api/notes')).json();
  document.getElementById('list').innerHTML = rows.map((r) => '<li>' + String(r.text).replace(/</g, '&lt;') + '</li>').join('');
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('t').value }) });
  document.getElementById('t').value = '';
  load();
});
load();
</script>
`);
console.log('built dist/index.html');
