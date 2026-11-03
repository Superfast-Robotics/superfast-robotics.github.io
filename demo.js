(() => {
  'use strict';
  const video = document.getElementById('demo-video');
  const button = document.querySelector('.fullscreen-button');
  const status = document.querySelector('.video-status');
  if (!video || !button) return;

  const standardFullscreen = typeof video.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
  const nativeFullscreen = typeof video.webkitEnterFullscreen === 'function';
  if (!standardFullscreen && !nativeFullscreen) return;

  button.hidden = false;
  button.addEventListener('click', async () => {
    if (status) status.hidden = true;
    try {
      if (standardFullscreen) await video.requestFullscreen();
      else video.webkitEnterFullscreen();
    } catch {
      if (status) status.hidden = false;
      video.focus();
    }
  });
})();
