// Desktop notifications (macOS, via osascript). A quiet no-op on other platforms or when
// COCKPIT_NO_NOTIFY is set, so nothing downstream has to guard its calls.
import { spawn } from 'node:child_process';

export function notify(title, message) {
  if (process.platform !== 'darwin' || process.env.COCKPIT_NO_NOTIFY) return;
  // Collapse control chars/newlines too: a newline makes the AppleScript string literal invalid
  // and the notification silently fails.
  const esc = s => String(s).replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    spawn('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}
