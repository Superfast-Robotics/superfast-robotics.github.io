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

(() => {
  'use strict';
  const plate = document.querySelector('.conditions-plate');
  const dialog = document.querySelector('.photo-viewer');
  if (!plate || !dialog || typeof dialog.showModal !== 'function') return;

  const links = Array.from(plate.querySelectorAll('.plate-photo'));
  const photo = new Image();
  const caption = dialog.querySelector('#viewer-caption');
  const counter = dialog.querySelector('.viewer-count');
  dialog.querySelector('.viewer-frame').append(photo);
  let index = 0;
  function show(i) {
    index = (i + links.length) % links.length;
    const link = links[index];
    const label = link.querySelector('img').alt;
    photo.alt = label;
    photo.src = link.href;
    caption.textContent = label;
    counter.textContent = (index + 1) + ' / ' + links.length;
  }
  plate.addEventListener('click', event => {
    const link = event.target.closest('.plate-photo');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    show(links.indexOf(link));
    dialog.showModal();
  });
  dialog.querySelector('.viewer-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.viewer-prev').addEventListener('click', () => show(index - 1));
  dialog.querySelector('.viewer-next').addEventListener('click', () => show(index + 1));
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    show(index + (event.key === 'ArrowRight' ? 1 : -1));
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
})();
