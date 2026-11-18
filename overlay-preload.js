// Gives the overlay page a few desktop abilities, and nothing else: capture the screen, tell the desktop
// app where its panels are (so clicks anywhere else go to the window behind), start meeting audio, and
// open the full app in your browser.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  screenshot: () => ipcRenderer.invoke('screenshot'),
  setPanels: (rects, dragging) => ipcRenderer.send('panels', rects, !!dragging),
  startAudio: () => ipcRenderer.send('start-audio'),
  openApp: () => ipcRenderer.send('open-app'),
  relaunch: () => ipcRenderer.send('relaunch'), // after saving settings
});
