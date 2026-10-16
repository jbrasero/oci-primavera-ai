(() => {
  const gate = document.querySelector('#auth-gate');
  const form = document.querySelector('#login-form');
  const username = document.querySelector('#login-username');
  const password = document.querySelector('#login-password');
  const submit = document.querySelector('#login-submit');
  const error = document.querySelector('#login-error');
  const logout = document.querySelector('#logout');
  const embedded = window.location.pathname.replace(/\/+$/, '') === '/unifier-portlet';
  const authHeaders = embedded ? { 'X-Unifier-Embed': '1' } : {};
  document.body.classList.toggle('is-unifier-portlet', embedded);
  document.querySelector('.login-note').textContent = embedded
    ? 'Sesión aislada para el portlet · las credenciales se verifican únicamente en este servidor'
    : 'Sesión local protegida · las credenciales se verifican únicamente en este servidor';

  function unlock() {
    gate.hidden = true;
    document.body.classList.remove('auth-pending');
    logout.hidden = false;
  }

  fetch('/api/auth/session', { cache: 'no-store', headers: authHeaders })
    .then(response => response.json())
    .then(session => { if (session.authenticated) unlock(); else username.focus(); })
    .catch(() => { error.textContent = 'No se pudo contactar con el servidor.'; });

  form.addEventListener('submit', async event => {
    event.preventDefault(); error.textContent = ''; submit.disabled = true; submit.textContent = 'Comprobando…';
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify({ username: username.value.trim(), password: password.value }) });
      const result = await response.json();
      if (!response.ok || !result.authenticated) throw new Error(result.error || 'No se pudo iniciar sesión.');
      window.location.reload();
    } catch (loginError) {
      error.textContent = loginError.message || 'No se pudo iniciar sesión.';
      password.value = ''; password.focus(); submit.disabled = false; submit.innerHTML = 'Entrar <span>→</span>';
    }
  });

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders }); } finally {
      ['unifierMissionFocus', 'unifierMissionResponseIds', 'unifierPreviousResponseId'].forEach(key => localStorage.removeItem(key));
      window.location.reload();
    }
  });
})();
