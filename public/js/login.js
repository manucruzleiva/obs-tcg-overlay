(function () {
  'use strict';

  const form = document.getElementById('form');
  const input = document.getElementById('password');
  const button = document.getElementById('submit');
  const error = document.getElementById('error');

  // Where to go afterwards: only ever a path on this site
  function destination() {
    const next = new URLSearchParams(window.location.search).get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : '/control';
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      if (response.ok) {
        window.location.replace(destination());
        return;
      }
      const data = await response.json().catch(() => ({}));
      showError(data.error || 'Could not sign in');
      input.select();
    } catch (failure) {
      showError('Could not reach the server');
    } finally {
      button.disabled = false;
    }
  });
}());
