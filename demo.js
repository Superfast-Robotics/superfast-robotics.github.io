(() => {
  'use strict';
  const video = document.getElementById('demo-video');
  if (!video) return;
  const speedButtons = Array.from(document.querySelectorAll('[data-demo-speed]'));
  let selectedRate = Number(video.dataset.defaultRate) || 4;
  function reflectRate() {
    speedButtons.forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.demoSpeed) === video.playbackRate));
    });
  }
  function applyRate() {
    video.defaultPlaybackRate = selectedRate;
    video.playbackRate = selectedRate;
    reflectRate();
  }
  speedButtons.forEach(button => {
    button.addEventListener('click', () => {
      selectedRate = Number(button.dataset.demoSpeed);
      applyRate();
    });
  });
  video.defaultMuted = true;
  video.muted = true;
  video.addEventListener('loadedmetadata', applyRate);
  video.addEventListener('ratechange', reflectRate);
  applyRate();
  const button = document.querySelector('.fullscreen-button');
  const status = document.querySelector('.video-status');
  if (!button) return;
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
  if (!plate) return;
  const links = Array.from(plate.querySelectorAll('.plate-photo'));
  const images = links.map(link => link.querySelector('img[data-animated-src]')).filter(Boolean);
  const toggle = plate.querySelector('.rollout-motion');
  const visible = new WeakMap();
  let paused = false;
  let index = 0;
  let opener = null;
  const dialog = document.querySelector('.photo-viewer');
  const canOpenDialog = dialog && typeof dialog.showModal === 'function';
  const viewerToggle = dialog?.querySelector('.viewer-motion');
  const photo = canOpenDialog ? new Image() : null;
  if (photo) {
    photo.id = 'viewer-rollout';
    photo.width = 640;
    photo.height = 360;
    dialog.querySelector('.viewer-frame').append(photo);
  }
  function setImage(image, play) {
    const source = play ? image.dataset.animatedSrc : image.dataset.stillSrc;
    if (source && image.getAttribute('src') !== source) image.src = source;
    image.dataset.motionState = play ? 'playing' : 'paused';
  }
  function sync() {
    const canPlay = !paused && !document.hidden;
    images.forEach(image => setImage(image, canPlay && !dialog?.open && Boolean(visible.get(image))));
    for (const button of [toggle, viewerToggle]) {
      if (!button) continue;
      button.hidden = false;
      button.setAttribute('aria-pressed', String(paused));
      button.textContent = paused ? 'Play clips' : 'Pause clips';
    }
    if (photo && dialog.open) setImage(photo, canPlay);
    else if (photo) photo.removeAttribute('src');
  }
  function setPaused(value) {
    paused = value;
    sync();
  }
  toggle?.addEventListener('click', () => setPaused(!paused));
  viewerToggle?.addEventListener('click', () => setPaused(!paused));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => visible.set(entry.target, entry.isIntersecting));
      sync();
    }, { threshold:0.01 });
    images.forEach(image => observer.observe(image));
  } else {
    const measure = () => {
      images.forEach(image => {
        const bounds = image.getBoundingClientRect();
        visible.set(image, bounds.bottom > 0 && bounds.top < window.innerHeight);
      });
      sync();
    };
    window.addEventListener('scroll', measure, { passive:true });
    window.addEventListener('resize', measure);
    measure();
  }
  document.addEventListener('visibilitychange', sync);
  if (canOpenDialog) {
    const caption = dialog.querySelector('#viewer-caption');
    const counter = dialog.querySelector('.viewer-count');
    function show(i) {
      index = (i + links.length) % links.length;
      const image = links[index].querySelector('img');
      photo.alt = image.alt;
      photo.dataset.animatedSrc = image.dataset.animatedSrc || links[index].href;
      photo.dataset.stillSrc = image.dataset.stillSrc || image.src;
      caption.textContent = image.alt;
      counter.textContent = (index + 1) + ' / ' + links.length;
      sync();
    }
    plate.addEventListener('click', event => {
      const link = event.target.closest('.plate-photo');
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      opener = link;
      dialog.showModal();
      show(links.indexOf(link));
    });
    dialog.querySelector('.viewer-close').addEventListener('click', () => dialog.close());
    dialog.querySelector('.viewer-prev').addEventListener('click', () => show(index - 1));
    dialog.querySelector('.viewer-next').addEventListener('click', () => show(index + 1));
    dialog.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      show(index + (event.key === 'ArrowRight' ? 1 : -1));
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      sync();
      opener?.focus({ preventScroll:true });
    });
  }
  sync();
})();
