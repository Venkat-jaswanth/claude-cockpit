// Terminal client: attaches the current terminal to a daemon-hosted session over WebSocket.
import { StringDecoder } from 'node:string_decoder';

export function attach(port, cs, { label = '' } = {}) {
  return new Promise(resolve => {
    const stdin = process.stdin, stdout = process.stdout;
    if (!stdin.isTTY || !stdout.isTTY) { process.stderr.write('cockpit: attach needs an interactive terminal\n'); return resolve(1); }
    const url = `ws://127.0.0.1:${port}/ws/${encodeURIComponent(cs)}?cols=${stdout.columns || 80}&rows=${stdout.rows || 24}`;
    const ws = new WebSocket(url);
    const decoder = new StringDecoder('utf8');
    let done = false, info = null;
    const finish = (code, msg) => {
      if (done) return; done = true;
      try { stdin.setRawMode(false); } catch {}
      try { stdin.pause(); } catch {}
      stdout.off('resize', onResize); stdin.off('data', onData);
      try { ws.close(); } catch {}
      if (msg) stdout.write(`\r\n\x1b[2m${msg}\x1b[0m\r\n`);
      resolve(code);
    };
    const onResize = () => { try { ws.send(JSON.stringify({ t: 'rs', cols: stdout.columns, rows: stdout.rows })); } catch {} };
    const onData = buf => {
      const i = buf.indexOf(0x1d); // Ctrl-]
      if (i >= 0) { const before = decoder.write(buf.subarray(0, i)); if (before) ws.send(JSON.stringify({ t: 'in', d: before })); return finish(0, `detached from ${info?.name || cs}; it keeps running. Reattach: cockpit attach ${cs}`); }
      const s = decoder.write(buf);
      if (s) { try { ws.send(JSON.stringify({ t: 'in', d: s })); } catch {} }
    };
    ws.onopen = () => {
      stdin.setRawMode(true); stdin.resume();
      stdin.on('data', onData); stdout.on('resize', onResize);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'out') stdout.write(m.d);
      else if (m.t === 'info') { if (!info) stdout.write(`\x1b[2mcockpit · ${label || m.name || cs} on seat ${m.seat} · Ctrl-] detaches, the session keeps running · http://127.0.0.1:${port}\x1b[0m\r\n`); info = m; }
      else if (m.t === 'exit') finish(typeof m.code === 'number' ? m.code : 0, `session ${info?.name || cs} ended`);
    };
    ws.onerror = () => finish(1, 'could not reach the cockpit daemon');
    ws.onclose = () => finish(0, done ? '' : 'connection to the daemon closed; the session may still be running');
    process.on('SIGTERM', () => finish(143, ''));
    process.on('SIGHUP', () => finish(129, ''));
  });
}
