// A plain static server for the built demo, optionally under a sub-path the
// way GitHub Pages serves a project site (/<repo>/).
//
//   npm run demo     build _site and serve it at http://127.0.0.1:8766/esp32-web-interface/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoSite } from './build.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

export function serveStatic(dir, { port = 0, base = '/' } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(base)) { res.writeHead(404); res.end('not found'); return; }
    // A folder URL serves its index.html, as GitHub Pages does (flash/)
    let rel = p.slice(base.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) { res.writeHead(404); res.end('not found'); return; }
    // Open once and check/read through the same descriptor, so the file
    // can't be swapped between the check and the read
    let buf;
    let fd;
    try {
      fd = fs.openSync(abs, 'r');
      if (!fs.fstatSync(fd).isFile()) throw new Error('not a file');
      buf = fs.readFileSync(fd);
    } catch {
      res.writeHead(404); res.end('not found'); return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}${base}`,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = buildDemoSite();
  const { url } = await serveStatic(out, { port: 8766, base: '/esp32-web-interface/' });
  console.log('Demo site running at ' + url);
}
