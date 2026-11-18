// Gives the overlay page three desktop abilities, and nothing else: capture the screen, tell the desktop
// app where its panels are (so clicks anywhere else go to the window behind), and start meeting audio.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  screenshot: () => ipcRenderer.invoke('screenshot'),
  setPanels: (rects, dragging) => ipcRenderer.send('panels', rects, !!dragging),
  startAudio: () => ipcRenderer.send('start-audio'),
});
