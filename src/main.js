import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerSaveBlocker, session, shell, systemPreferences } from 'electron';
import { desktopCapturer } from 'electron';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createShareServer } from './server.js';
import { normalizePort, publicViewerUrl } from './config.js';
import { RelaySession } from './relay-client.js';

let share;
let mainWindow;
let selectedSourceId;
let sharing = false;
let sleepBlocker;
let quitting = false;
let closing = false;
const remoteSession = new RelaySession();
if (process.platform === 'darwin' && process.env.CHDSS_MAC_AUDIO === 'screencapturekit') {
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');
}

function trustedFrame(frame) {
  try { const url = new URL(frame?.url); return url.origin === share.localUrl && url.pathname === '/host.html'; }
  catch { return false; }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedFrame(event.senderFrame)) throw new Error('Untrusted IPC caller');
    return callback(...args);
  });
}

function setSharing(active) {
  sharing = active === true;
  if (sharing && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!sharing && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
}

async function requestQuit() {
  if (closing || quitting) return;
  closing = true;
  try {
    if (sharing || remoteSession.active) {
      const result = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'End sharing and quit CHDSS?', detail: 'Your LAN stream and Internet session will be stopped.', buttons: ['Keep sharing', 'End and quit'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    try { await remoteSession.end(); } catch {
      const result = await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'The server could not confirm session closure.', detail: 'Quitting stops your upload, but the password may remain valid until the server session expires. Retry, or quit and stop the session on the server.', buttons: ['Go back', 'Quit anyway'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    quitting = true;
    setSharing(false);
    await share?.close();
    app.quit();
  } finally { closing = false; }
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter(entry => entry && entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
}

async function configureCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sourceId = selectedSourceId;
    selectedSourceId = undefined;
    if (request.frame !== mainWindow?.webContents.mainFrame || !trustedFrame(request.frame) || !sourceId) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === sourceId);
      callback(source ? { video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) } : {});
    } catch { callback({}); }
  }, { useSystemPicker: false });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === mainWindow?.webContents && trustedFrame(contents.mainFrame) && ['media', 'display-capture'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === mainWindow?.webContents && trustedFrame(contents.mainFrame) && ['media', 'display-capture'].includes(permission));
}

async function createWindow() {
  const token = randomBytes(24).toString('base64url');
  const hostToken = randomBytes(32).toString('base64url');
  const port = normalizePort(process.env.CHDSS_PORT);
  share = await createShareServer({ port, token, hostToken });
  await configureCapture();
  const addresses = lanAddresses();
  const viewerUrls = addresses.map(address => publicViewerUrl(address, share.port, token));
  if (!viewerUrls.length) viewerUrls.push(publicViewerUrl('127.0.0.1', share.port, token));

  handle('chdss:details', () => ({
    hostToken,
    version: app.getVersion(),
    viewerUrls,
    platform: process.platform,
    screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  }));
  handle('chdss:copy', text => clipboard.writeText(String(text).slice(0, 8192)));
  const openPermissions = () => shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' : 'ms-settings:privacy-broadfilesystemaccess');
  handle('chdss:permissions', openPermissions);
  handle('chdss:sharing', setSharing);
  handle('chdss:relay-create', (url, key) => remoteSession.create(url, key));
  handle('chdss:relay-end', () => remoteSession.end());
  handle('chdss:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return sources.map(source => ({ id: source.id, name: source.name }));
  });
  handle('chdss:select-source', async sourceId => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(item => item.id === sourceId);
    if (!source) throw new Error('The selected screen or window is no longer available.');
    selectedSourceId = source.id;
  });

  mainWindow = new BrowserWindow({
    width: 1160,
    height: 850,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#101114',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 22 },
    show: false,
    title: "Christian's Handy Dandy Screen Share",
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => { setSharing(false); remoteSession.end().catch(() => {}); });
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  const command = name => mainWindow.webContents.send('chdss:command', name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Stream', submenu: [
      { label: 'Start / Stop Sharing', accelerator: 'CommandOrControl+Shift+S', click: () => command('toggle-sharing') },
      { label: 'Refresh Sources', accelerator: 'CommandOrControl+R', click: () => command('refresh-sources') },
      { label: 'Screen Recording Permissions…', click: openPermissions },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { role: 'editMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'About CHDSS', click: () => dialog.showMessageBox(mainWindow, { message: `CHDSS ${app.getVersion()}`, detail: 'Christian’s Handy Dandy Screen Share\nLAN by default. Your server when you need it.\nInternet mode uses your trusted server to forward media. System audio includes all playing applications.' }) }] }
  ]));
  await mainWindow.loadURL(`${share.localUrl}/host.html`);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(createWindow).catch(error => { dialog.showErrorBox('CHDSS could not start', error.code === 'EADDRINUSE' ? 'Port 41730 is in use. Quit the other CHDSS instance, or set CHDSS_PORT to another port.' : error.message); quitting = true; app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
}
