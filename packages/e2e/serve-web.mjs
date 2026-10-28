// Serves an Expo web export (`web.output: single`) for the end-to-end run: static files, with
// index.html for every app route. Usage: node serve-web.mjs <export directory> <port>
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg || !portArg) throw new Error('Usage: node serve-web.mjs <dir> <port>');
const root = resolve(dirArg);
if (!existsSync(join(root, 'index.html'))) throw new Error(`No index.html in ${root}`);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const candidate = normalize(join(root, path));
  // Never serve outside the export directory.
  const file =
    candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(root, 'index.html');
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(Number(portArg), () => console.log(`serving ${root} on http://localhost:${portArg}`));
