'use strict';

import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import * as keytar from 'keytar';
import crypto from 'crypto';

const KEYCHAIN_SERVICE = 'cryptodesk';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    titleBarStyle: 'hiddenInset',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' 'unsafe-eval' https://api.binance.com https://www.okx.com https://cdn.jsdelivr.net https://pro-api.coinmarketcap.com"],
      },
    });
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('get-api-key', (_e, account: string) =>
  keytar.getPassword(KEYCHAIN_SERVICE, account),
);

ipcMain.handle('set-api-key', (_e, account: string, key: string) =>
  keytar.setPassword(KEYCHAIN_SERVICE, account, key),
);

ipcMain.handle(
  'okx-request',
  async (_e, { method, path: reqPath, params }: { method: string; path: string; params?: Record<string, string> }) => {
    try {
      const [apiKey, secret, passphrase] = await Promise.all([
        keytar.getPassword(KEYCHAIN_SERVICE, 'okx-key'),
        keytar.getPassword(KEYCHAIN_SERVICE, 'okx-secret'),
        keytar.getPassword(KEYCHAIN_SERVICE, 'okx-passphrase'),
      ]);

      if (!apiKey || !secret || !passphrase) {
        return { ok: false, data: null, msg: 'OKX API keys not configured' };
      }

      const timestamp  = new Date().toISOString();
      const isGet      = method.toUpperCase() === 'GET';
      const qs         = isGet && params && Object.keys(params).length > 0
        ? new URLSearchParams(params).toString()
        : '';
      const querySuffix = qs ? `?${qs}` : '';
      const body        = isGet ? '' : JSON.stringify(params ?? {});

      const prehash = isGet
        ? `${timestamp}GET${reqPath}${querySuffix}`
        : `${timestamp}POST${reqPath}${body}`;

      const sign = crypto.createHmac('sha256', secret).update(prehash).digest('base64');

      const url = `https://www.okx.com${reqPath}${querySuffix}`;
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          'OK-ACCESS-KEY':        apiKey,
          'OK-ACCESS-SIGN':       sign,
          'OK-ACCESS-TIMESTAMP':  timestamp,
          'OK-ACCESS-PASSPHRASE': passphrase,
          'Content-Type':         'application/json',
        },
        ...(isGet ? {} : { body }),
      });

      const data = await res.json() as unknown;
      return { ok: res.ok, data, msg: res.ok ? '' : res.statusText };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, msg };
    }
  },
);
