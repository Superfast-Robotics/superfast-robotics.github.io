(() => {
  'use strict';
  const button = document.querySelector('.copy-bib');
  const code = document.querySelector('.bibtex code');
  const status = document.querySelector('.copy-status');
  if (!button || !code || !status) return;
  button.hidden = false;
  let feedbackTimer;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent + '\n');
      clearTimeout(feedbackTimer);
      button.classList.add('is-copied');
      status.textContent = 'Copied.';
      feedbackTimer = setTimeout(() => {
        button.classList.remove('is-copied');
        status.textContent = '';
      }, 2000);
    } catch {
      clearTimeout(feedbackTimer);
      button.classList.remove('is-copied');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'BibTeX selected. Use your device’s copy command.';
    }
  });
})();
