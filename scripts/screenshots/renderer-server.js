// Local-only sample backend for Google's public, unmodified Remote Control UI.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const upstream = require('./upstream-renderer.json');
const fixtures = require('./threadData.json');
const { readSchemas, encodeStreamMessage } = require('./protobuf-fixtures');

const PORT = 5187;
const CACHE = path.join(os.tmpdir(), 'antigravity-screenshot-renderer', upstream.version);
const prefix = `/web/${upstream.version}/`;
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');

async function startRendererServer() {
  const assets = {};
  async function readAsset(name) {
    if (!name || name.split('/').includes('..')) throw new Error('Invalid upstream asset path');
    const file = path.join(CACHE, name);
    if (!fs.existsSync(file)) {
      const response = await fetch(new URL(name === 'index.html' ? '' : name, upstream.url));
      if (!response.ok) throw new Error(`Upstream asset ${name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    }
    const bytes = fs.readFileSync(file), hash = sha256(bytes);
    if (upstream.sha256[name] && upstream.sha256[name] !== hash) throw new Error(`Upstream asset checksum changed: ${name}`);
    assets[name] = hash;
    return bytes;
  }
  for (const name of ['index.html', ...Object.keys(upstream.sha256)]) await readAsset(name);
  const schemas = readSchemas((await readAsset('main.js')).toString());
  const host = fs.readFileSync(path.join(__dirname, 'renderer-host.html'), 'utf8').replaceAll('__RENDERER_VERSION__', upstream.version);
  let readyCount = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
      if (url.pathname === '/sample/ready') {
        if (request.method === 'POST') readyCount++;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ readyCount })); return;
      }
      if (url.pathname === '/sample/rpc') {
        const method = url.searchParams.get('path');
        if (!schemas.methods.has(method)) { response.writeHead(404).end(); return; }
        const data = fixtures[method.split('/').pop()] || {};
        response.setHeader('content-type', 'application/octet-stream');
        response.end(url.searchParams.get('stream') === 'true' ? encodeStreamMessage(schemas, method, data) : JSON.stringify(data)); return;
      }
      if (url.pathname.startsWith(prefix)) {
        const name = url.pathname.slice(prefix.length) || 'index.html';
        let bytes = await readAsset(name);
        // Only asset URLs in the document are mapped to the local cache. All
        // upstream scripts and styles are served byte-for-byte unchanged.
        if (name === 'index.html') bytes = Buffer.from(bytes.toString().replaceAll(upstream.url, prefix));
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
        response.setHeader('content-type', types[path.extname(name)] || 'application/octet-stream'); response.end(bytes); return;
      }
      if (url.pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(host); return; }
      response.writeHead(404).end();
    } catch (error) { console.error(error.message); response.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  return { port: PORT, get readyCount() { return readyCount; }, provenance: () => ({ ...upstream, assets }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

module.exports = { startRendererServer };
