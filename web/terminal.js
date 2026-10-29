const cs = decodeURIComponent(location.pathname.split('/').pop());
const $ = s => document.querySelector(s);
// Terminal appearance presets, kept in sync with the dashboard's Settings (localStorage cockpit.term).
const TERM_THEMES = {
  Midnight: { background: '#0f1115', foreground: '#e6e6ea', cursor: '#e6e6ea', selectionBackground: 'rgba(120,120,170,.35)' },
  Graphite: { background: '#1b1b1e', foreground: '#f0f0f3', cursor: '#f0f0f3', selectionBackground: 'rgba(255,255,255,.18)' },
  Matrix: { background: '#001400', foreground: '#39ff14', cursor: '#39ff14', selectionBackground: 'rgba(57,255,20,.25)' },
  Cyberpunk: { background: '#0b0221', foreground: '#ff2fb9', cursor: '#00e5ff', selectionBackground: 'rgba(0,229,255,.25)' },
  Paper: { background: '#f7f7f4', foreground: '#1d1d1f', cursor: '#1d1d1f', selectionBackground: 'rgba(0,0,0,.12)' },
};
const termPrefs = () => { try { return { theme: 'Midnight', fontSize: 13, cursor: 'block', ...JSON.parse(localStorage.getItem('cockpit.term') || '{}') }; } catch { return { theme: 'Midnight', fontSize: 13, cursor: 'block' }; } };
const _tp = termPrefs(), _theme = TERM_THEMES[_tp.theme] || TERM_THEMES.Midnight;
const term = new Terminal({ cursorBlink: true, cursorStyle: _tp.cursor || 'block', fontSize: Number(_tp.fontSize) || 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: _theme, scrollback: 5000, allowProposedApi: true });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
const searchAddon = (typeof SearchAddon !== 'undefined') ? new SearchAddon.SearchAddon() : null;
if (searchAddon) term.loadAddon(searchAddon);
if (typeof WebLinksAddon !== 'undefined') term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
term.open($('#term'));
document.body.style.background = _theme.background; $('#term').style.background = _theme.background;
fit.fit();
let ws = null, info = null, closedByServer = false;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws/${encodeURIComponent(cs)}?cols=${term.cols}&rows=${term.rows}`);
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'out') term.write(m.d);
    else if (m.t === 'info') { info = m; renderInfo(); }
    else if (m.t === 'exit') { closedByServer = true; showOverlay('Session ended', `exit code ${m.code ?? '?'}`); }
  };
  ws.onclose = () => { if (!closedByServer) showOverlay('Disconnected', 'The daemon closed the connection. Reload to try again.'); };
}
function baseName(p) { return p ? (p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '') : ''; }
function renderInfo() {
  if (!info) return;
  // Prefer the session's name; fall back to its folder so the tab is readable, not a raw id.
  const label = info.name || baseName(info.cwd) || cs;
  document.title = `${label} · ${info.seat} · Claude Cockpit`;
  $('#tname').textContent = label;
  $('#tseat').textContent = `seat ${info.seat}`;
  $('#tstatus').textContent = (info.status || '').replace('_', ' ');
  $('#tcwd').textContent = info.cwd || '';
  $('#btnHandoff').disabled = !(info.kind === 'claude' && info.alive);
}
function showOverlay(title, text) { $('#ovTitle').textContent = title; $('#ovText').textContent = text; $('#overlay').classList.add('show'); }
term.onData(d => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'in', d })); });
term.onResize(({ cols, rows }) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'rs', cols, rows })); });
window.addEventListener('resize', () => fit.fit());
async function post(p, body) { const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const j = await r.json(); if (!r.ok) alert(j.error || 'failed'); return j; }
$('#btnTerminal').onclick = () => post(`/api/sessions/${cs}/open-terminal`);
$('#btnHandoff').onclick = () => post(`/api/sessions/${cs}/handoff`, { toSeat: $('#handoffSeat').value || null });
$('#btnStop').onclick = () => { if (confirm('Stop this session? You can resume it later from the dashboard.')) post(`/api/sessions/${cs}/stop`); };
$('#btnRestore').onclick = async () => { const j = await post(`/api/sessions/${cs}/restore`, { seat: $('#restoreSeat').value || null, cols: term.cols, rows: term.rows }); if (j.ok) location.reload(); };
async function loadSeats() {
  try {
    const st = await (await fetch('/api/state')).json();
    for (const sel of [$('#handoffSeat'), $('#restoreSeat')]) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">Best seat</option>' + st.seats.filter(s => !s.disabled).map(s => `<option value="${s.name}">${s.name} · ${s.usage?.fiveHour?.pct ?? '–'}%</option>`).join('');
      sel.value = cur;
    }
  } catch {}
}
// Find in scrollback (⌘F / Ctrl-F), via the search addon.
if (searchAddon) {
  const sb = $('#tsearch'), sbi = $('#tsearchInput'), sbc = $('#tsearchCount');
  const decos = { matchBackground: '#3a3a52', activeMatchBackground: '#5eead4', activeMatchColorOverviewRuler: '#5eead4', matchOverviewRuler: '#5eead4' };
  const find = dir => { const q = sbi.value; if (!q) { sbc.textContent = ''; try { searchAddon.clearDecorations(); } catch {} return; } try { dir < 0 ? searchAddon.findPrevious(q, { decorations: decos }) : searchAddon.findNext(q, { decorations: decos }); } catch {} };
  const openS = () => { sb.hidden = false; sbi.focus(); sbi.select(); };
  const closeS = () => { sb.hidden = true; sbc.textContent = ''; try { searchAddon.clearDecorations(); } catch {} term.focus(); };
  searchAddon.onDidChangeResults?.(r => { sbc.textContent = r && r.resultCount >= 0 ? (r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : 'none') : ''; });
  term.attachCustomKeyEventHandler(e => { if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openS(); return false; } return true; });
  sbi.addEventListener('input', () => find(1));
  sbi.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeS(); } });
  $('#tsearchNext').onclick = () => find(1); $('#tsearchPrev').onclick = () => find(-1); $('#tsearchClose').onclick = closeS;
}
loadSeats(); setInterval(loadSeats, 10000);
connect();
term.focus();
