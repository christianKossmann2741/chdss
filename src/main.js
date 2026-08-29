import { app, BrowserWindow, clipboard, ipcMain, session, shell, systemPreferences } from 'electron';
import { desktopCapturer } from 'electron';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createShareServer } from './server.js';
import { normalizePort, publicViewerUrl } from './config.js';

let share;
let mainWindow;

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter(entry => entry && entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
}

async function configureCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    callback({ video: sources[0], audio: 'loopback' });
  }, { useSystemPicker: true });
}

async function createWindow() {
  const token = randomBytes(24).toString('base64url');
  const port = normalizePort(process.env.CHDSS_PORT);
  share = await createShareServer({ port, token });
  await configureCapture();
  const addresses = lanAddresses();
  const viewerUrls = addresses.map(address => publicViewerUrl(address, share.port, token));
  if (!viewerUrls.length) viewerUrls.push(publicViewerUrl('127.0.0.1', share.port, token));

  ipcMain.handle('chdss:details', () => ({
    viewerUrls,
    platform: process.platform,
    screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  }));
  ipcMain.handle('chdss:copy', (_event, text) => clipboard.writeText(String(text)));
  ipcMain.handle('chdss:permissions', () => shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' : 'ms-settings:privacy-broadfilesystemaccess'));

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 790,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#090b0f',
    title: "Christian's Handy Dandy Screen Share",
    webPreferences: { preload: new URL('./preload.cjs', import.meta.url).pathname, contextIsolation: true, nodeIntegration: false }
  });
  await mainWindow.loadURL(`${share.localUrl}/host.html#${token}`);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(createWindow).catch(error => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { share?.close(); });
}
