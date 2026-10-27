// Tiny HTTP client the CLI uses to talk to the local daemon's JSON API on 127.0.0.1.
// Kept dependency-free on purpose; this is the only thing the `cockpit` command needs to
// reach the daemon.
import http from 'node:http';

export function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path, timeout: 8000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

export async function health(port) {
  try { const r = await request(port, 'GET', '/api/health'); return r.status === 200 ? r.body : null; } catch { return null; }
}
