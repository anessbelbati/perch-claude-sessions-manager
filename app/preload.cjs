'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_event, ...args) => fn(...args));

contextBridge.exposeInMainWorld('desk', {
  info: () => ipcRenderer.invoke('desk:info'),
  create: (ask) => ipcRenderer.invoke('desk:create', ask),
  close: (id) => ipcRenderer.invoke('desk:close', id),
  rename: (id, title) => ipcRenderer.send('desk:rename', id, title),
  input: (id, data) => ipcRenderer.send('desk:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('desk:resize', id, { cols, rows }),
  pickFolder: () => ipcRenderer.invoke('desk:pick-folder'),
  recent: () => ipcRenderer.invoke('desk:recent'),
  usage: (range) => ipcRenderer.invoke('desk:usage', range),
  typed: (query) => ipcRenderer.invoke('desk:typed', query),
  read: (ask) => ipcRenderer.invoke('desk:read', ask),
  history: () => ipcRenderer.invoke('desk:history'),
  refresh: () => ipcRenderer.invoke('desk:refresh'),
  showFile: (key, agent) => ipcRenderer.invoke('desk:show-file', key, agent),
  forget: (session) => ipcRenderer.send('desk:forget', session),
  previousDone: () => ipcRenderer.send('desk:previous-done'),
  settings: (patch) => ipcRenderer.invoke('desk:settings', patch),
  shortcut: (kind, on) => ipcRenderer.invoke('desk:shortcut', kind, on),
  readClipboard: () => ipcRenderer.invoke('desk:clip-read'),
  writeClipboard: (text) => ipcRenderer.send('desk:clip-write', text),
  openUrl: (url) => ipcRenderer.send('desk:open-url', url),
  openFolder: (dir) => ipcRenderer.send('desk:open-folder', dir),
  badge: (image, text) => ipcRenderer.send('desk:badge', image, text),
  watchAgain: () => ipcRenderer.send('desk:watch-again'),
  // where a file dropped onto the window lives on disk
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  quit: () => ipcRenderer.send('desk:quit'),
  leave: (how, remember) => ipcRenderer.send('desk:leave', how, remember),
  front: (id) => ipcRenderer.send('desk:front', id),
  onOutput: on('desk:output'),
  onExit: on('desk:exit'),
  onChats: on('desk:chats'),
  onSnapshot: on('desk:snapshot'),
  onRes: on('desk:res'),
  onCommand: on('desk:command'),
});
