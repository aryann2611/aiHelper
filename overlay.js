// Desktop overlay: an invisible, always-on-top window over the whole screen.
// Clicks pass through everywhere except on the overlay's own panels, and screen sharing can't see it.
// Run with `npm run overlay`. Starts server.js too if it isn't already running.
const path = require('path');
const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, session } = require('electron');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;

async function ensureServer() {
  try { await fetch(`${URL}/api/status`); } // already running in another terminal
  catch { require('./server'); await new Promise((r) => setTimeout(r, 500)); }
}

app.whenReady().then(async () => {
  await ensureServer();
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    ...area, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false,
    hasShadow: false, alwaysOnTop: true, title: 'Answers overlay', type: process.platform === 'win32' ? 'toolbar' : 'panel',
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setContentProtection(true);                      // excluded from screen sharing and screenshots
  win.setIgnoreMouseEvents(true, { forward: true });   // clicks go through until the pointer is over a panel
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const keepOnTop = setInterval(() => (win.isDestroyed() ? clearInterval(keepOnTop) : win.setAlwaysOnTop(true, 'screen-saver')), 1000); // Windows sometimes drops it
  win.loadURL(`${URL}/overlay.html`);

  // Clicks: the page reports where its panels are; here the pointer position is checked 40 times a second
  // and the overlay takes the mouse only while it's over a panel. This doesn't rely on mouse-move events,
  // which Windows withholds over some windows (for example apps running as administrator).
  let panels = [], dragging = false, holding = false;
  ipcMain.on('panels', (_e, rects, isDragging) => {
    panels = Array.isArray(rects) ? rects : []; dragging = isDragging;
    if (process.env.OVERLAY_DEBUG) console.log(`panels ${JSON.stringify(panels)} dragging=${dragging}`);
  });
  // If the page reloads or crashes it can't report anymore: forget its panels so the screen is never blocked.
  const forget = () => { panels = []; dragging = false; };
  win.webContents.on('did-start-navigation', forget);
  win.webContents.on('render-process-gone', forget);
  const watch = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(watch);
    const c = screen.getCursorScreenPoint(), b = win.getContentBounds(), x = c.x - b.x, y = c.y - b.y;
    const over = dragging || (win.isVisible() && panels.some(([l, t, r, btm]) => x >= l - 3 && x <= r + 3 && y >= t - 3 && y <= btm + 3));
    if (over !== holding) {
      holding = over;
      win.setIgnoreMouseEvents(!over, { forward: true });
      if (process.env.OVERLAY_DEBUG) console.log(`pointer ${x},${y} -> ${over ? 'overlay takes clicks' : 'clicks pass through'}`);
    }
  }, 25);

  // Meeting audio: when the page asks to capture the screen, hand it the computer's sound ("loopback"),
  // which is what the other people in the meeting say, even through headphones.
  session.defaultSession.setDisplayMediaRequestHandler((_req, grant) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => grant({ video: s[0], audio: 'loopback' })).catch(() => grant({}));
  });
  // Starting a capture needs a user gesture; this runs the page's start function as if one happened.
  ipcMain.on('start-audio', () => win.webContents.executeJavaScript('startMeetingAudio()', true).catch(() => {}));

  // Screenshot of the screen the mouse is on. The overlay itself is excluded from the capture.
  ipcMain.handle('screenshot', async () => {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    return `data:image/jpeg;base64,${src.thumbnail.toJPEG(80).toString('base64')}`;
  });

  // Keyboard shortcuts. They work from any app while the overlay is running.
  const run = (js) => win.webContents.executeJavaScript(js).catch(() => {});
  globalShortcut.register('CommandOrControl+Enter', () => run('answerNow()'));
  globalShortcut.register('CommandOrControl+Shift+Enter', () => run('takeScreenshot()'));
  globalShortcut.register('CommandOrControl+Shift+Space', () => { win.showInactive(); win.focus(); run('openChat()'); });
  globalShortcut.register('CommandOrControl+Shift+H', () => (win.isVisible() ? win.hide() : win.showInactive()));
  win.on('closed', () => app.quit());
});
app.on('will-quit', () => globalShortcut.unregisterAll());
