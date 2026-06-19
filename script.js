/* ===================================================================
 * GhostMail — Temporary Email Service
 * Frontend-only, powered by Mail.tm API (https://api.mail.tm)
 *
 * Flow:
 *   1) GET   /domains          → pick domain
 *   2) POST  /accounts         → create account
 *   3) POST  /token            → login → bearer token
 *   4) GET   /messages         → fetch inbox (Bearer auth)
 *   5) GET   /messages/{id}    → read full message
 *
 *   DELETE /accounts/{id}      → delete inbox on logout
 * =================================================================== */

(() => {
  'use strict';

  /* ---------- CONFIG ---------- */
  const API_BASE = 'https://api.mail.tm';
  const STORAGE_KEY = 'ghostmail_session';
  const REFRESH_INTERVAL = 5000;
  const MIN_PASSWORD_LEN = 6;

  /* ---------- STATE ---------- */
  const state = {
    token: null,
    accountId: null,
    email: null,
    password: null,
    domain: null,
    messages: [],
    seenIds: new Set(),
    selectedMessageId: null,
    refreshTimer: null,
    countdownTimer: null,
    countdown: 5,
    currentTab: 'signin',
  };

  /* ---------- DOM HELPERS ---------- */
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ---------- TOAST ---------- */
  function showToast(msg, type = '') {
    const t = $('toast');
    t.textContent = (type === 'success' ? '✓ ' : type === 'error' ? '✕ ' : '') + msg;
    t.className = 'toast show ' + type;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), 2800);
  }

  /* ---------- CONFIRM DIALOG ---------- */
  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      const modal = $('confirmModal');
      $('confirmTitle').textContent = title;
      $('confirmMessage').textContent = message;
      modal.classList.remove('hidden');

      const ok = $('confirmOk');
      const cancel = $('confirmCancel');

      const cleanup = (result) => {
        modal.classList.add('hidden');
        ok.removeEventListener('click', okHandler);
        cancel.removeEventListener('click', cancelHandler);
        resolve(result);
      };
      const okHandler = () => cleanup(true);
      const cancelHandler = () => cleanup(false);
      ok.addEventListener('click', okHandler);
      cancel.addEventListener('click', cancelHandler);
    });
  }

  /* ---------- STORAGE ---------- */
  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        token: state.token,
        accountId: state.accountId,
        email: state.email,
        password: state.password,
        domain: state.domain,
        seenIds: Array.from(state.seenIds),
      }));
    } catch (e) {}
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    state.token = state.accountId = state.email = state.password = state.domain = null;
    state.messages = [];
    state.seenIds = new Set();
    state.selectedMessageId = null;
  }

  /* ---------- API WRAPPER ---------- */
  async function apiRequest(path, options = {}) {
    const headers = {
      'Accept': 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };

    if (options.auth && state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const res = await fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch (e) {}
      const err = new Error(
        (errBody && (errBody['detail'] || errBody['hydra:description'])) ||
        `HTTP ${res.status}`
      );
      err.status = res.status;
      err.body = errBody;
      throw err;
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* ---------- MAIL.TM FLOW ---------- */
  async function getDomain() {
    const data = await apiRequest('/domains?page=1');
    const members = data['hydra:member'] || data.member || [];
    if (!members.length) throw new Error('No domains available right now');
    return members[0].domain;
  }

  async function createAccount(address, password) {
    return apiRequest('/accounts', {
      method: 'POST',
      body: { address, password },
    });
  }

  async function loginAccount(address, password) {
    const data = await apiRequest('/token', {
      method: 'POST',
      body: { address, password },
    });
    return data.token;
  }

  async function fetchMessages() {
    const data = await apiRequest('/messages?page=1', { auth: true });
    return data['hydra:member'] || data.member || [];
  }

  async function fetchMessage(id) {
    return apiRequest('/messages/' + id, { auth: true });
  }

  async function deleteAccount() {
    if (!state.accountId) return;
    try {
      await apiRequest('/accounts/' + state.accountId, {
        method: 'DELETE',
        auth: true,
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- HELPERS ---------- */
  function randomString(len = 14) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  function randomPassword(len = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < len; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s + 'Aa1!';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.replace(/@.*$/, '').split(/[.\s_-]/).filter(Boolean);
    if (!parts.length) return name.charAt(0).toUpperCase();
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 7) {
      return d.toLocaleDateString([], { weekday: 'short' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatFullDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  /* ---------- HTML SANITIZER ---------- */
  function sanitizeHtml(html) {
    let safe = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    safe = safe.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*\/?>/gi, '');
    safe = safe.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    safe = safe.replace(/(href|src|xlink:href|formaction)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
    return safe;
  }

  function buildBodyHtml(m) {
    if (m.html && typeof m.html === 'string' && m.html.trim()) {
      return sanitizeHtml(m.html);
    }
    if (m.content && Array.isArray(m.content) && m.content.length) {
      const htmlPart = m.content.find((p) => (p.contentType || '').includes('html'));
      const textPart = m.content.find((p) => (p.contentType || '').includes('plain') || !p.contentType);
      if (htmlPart) return sanitizeHtml(htmlPart.content || '');
      if (textPart) return `<pre>${escapeHtml(textPart.content || '')}</pre>`;
    }
    if (m.text) return `<pre>${escapeHtml(m.text)}</pre>`;
    return '<p style="color:var(--text-faint);">(empty message)</p>';
  }

  /* ---------- GENERATE INBOX (SKIP FLOW) ---------- */
  async function generateInbox() {
    setAuthLoading(true);
    clearAuthError();
    try {
      const domain = await getDomain();
      const local = randomString(14);
      const email = `${local}@${domain}`;
      const password = randomPassword();

      const account = await createAccount(email, password);
      state.accountId = account.id;
      state.domain = domain;
      state.password = password;
      state.email = email;

      state.token = await loginAccount(email, password);
      saveSession();
      showInboxPage();
      showToast('Inbox ready!', 'success');
    } catch (err) {
      console.error('Generate inbox failed:', err);
      showAuthError('Failed to generate inbox: ' + err.message);
    } finally {
      setAuthLoading(false);
    }
  }

  /* ---------- AUTH (SIGN IN / SIGN UP) ---------- */
  function setAuthLoading(loading) {
    const btn = $('authSubmit');
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  function showAuthError(msg) { $('authError').textContent = msg; }
  function clearAuthError() { $('authError').textContent = ''; }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    clearAuthError();

    const email = $('emailInput').value.trim().toLowerCase();
    const password = $('passwordInput').value;

    if (!email || !password) {
      return showAuthError('Please fill in all fields.');
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return showAuthError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
    }

    setAuthLoading(true);
    try {
      if (state.currentTab === 'signup') {
        try {
          const account = await createAccount(email, password);
          state.accountId = account.id;
        } catch (createErr) {
          // If account exists, fall through to login.
          if (createErr.status !== 400 && createErr.status !== 422) {
            throw createErr;
          }
        }
      }
      state.token = await loginAccount(email, password);
      state.email = email;
      state.password = password;
      saveSession();
      showInboxPage();
      showToast('Signed in successfully', 'success');
    } catch (err) {
      console.error('Auth failed:', err);
      showAuthError('Authentication failed: ' + err.message);
    } finally {
      setAuthLoading(false);
    }
  }

  /* ---------- PAGE NAVIGATION ---------- */
  function showAuthPage() {
    $('authPage').classList.add('active');
    $('inboxPage').classList.remove('active');
    stopInbox();
  }

  function showInboxPage() {
    $('authPage').classList.remove('active');
    $('inboxPage').classList.add('active');
    $('currentEmail').textContent = state.email || '—';
    startInbox();
  }

  /* ---------- INBOX ---------- */
  async function refreshInbox(silent = false) {
    if (!state.token) return;
    try {
      const msgs = await fetchMessages();
      msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      state.messages = msgs;
      renderMessageList();
      if (!silent) showToast('Inbox refreshed', 'success');
    } catch (err) {
      console.error('Fetch messages failed:', err);
      if (err.status === 401) {
        stopInbox();
        clearSession();
        showAuthPage();
        showToast('Session expired — please sign in again', 'error');
      } else if (!silent) {
        showToast('Refresh failed: ' + err.message, 'error');
      }
    }
  }

  function renderMessageList() {
    const list = $('messageList');
    const empty = $('emptyInbox');
    const count = $('inboxCount');
    const searchTerm = ($('searchInput').value || '').toLowerCase().trim();

    let msgs = state.messages;
    if (searchTerm) {
      msgs = msgs.filter((m) => {
        const sender = (m.from && (m.from.address || m.from.name)) || '';
        const subject = m.subject || '';
        return sender.toLowerCase().includes(searchTerm) || subject.toLowerCase().includes(searchTerm);
      });
    }

    count.textContent = state.messages.length;

    if (!msgs.length) {
      list.innerHTML = '';
      if (state.messages.length === 0) {
        empty.classList.remove('hidden');
      } else {
        empty.classList.add('hidden');
        list.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px;">No matches found</div>`;
      }
      return;
    }
    empty.classList.add('hidden');

    list.innerHTML = msgs.map((m) => {
      const sender = (m.from && (m.from.address || m.from.name)) || 'Unknown';
      const subject = m.subject || '(no subject)';
      const intro = (m.intro || '').replace(/\s+/g, ' ').trim();
      const seen = state.seenIds.has(m.id);
      const isActive = state.selectedMessageId === m.id;
      const time = formatTime(m.createdAt);
      const initials = getInitials(sender);

      return `
        <div class="message-item ${isActive ? 'active' : ''} ${seen ? '' : 'unread'}" data-id="${escapeHtml(m.id)}">
          <div class="message-avatar">${escapeHtml(initials)}</div>
          <div class="message-content">
            <div class="msg-row">
              <span class="msg-sender-name">${escapeHtml(sender)}</span>
              <span class="msg-time">${escapeHtml(time)}</span>
            </div>
            <div class="msg-subject">${escapeHtml(subject)}</div>
            <div class="msg-preview">${escapeHtml(intro || 'No preview available')}</div>
          </div>
          ${seen ? '' : '<div class="unread-dot"></div>'}
        </div>
      `;
    }).join('');

    list.querySelectorAll('.message-item').forEach((el) => {
      el.addEventListener('click', () => openMessage(el.dataset.id));
    });
  }

  async function openMessage(id) {
    state.selectedMessageId = id;
    $$('.message-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });

    const viewer = $('emailViewer');
    viewer.innerHTML = `
      <div class="viewer-loading">
        <div class="spinner"></div>
        <p>Loading message…</p>
      </div>
    `;
    viewer.classList.add('show-mobile');

    try {
      const m = await fetchMessage(id);
      renderMessageDetail(m);
      state.seenIds.add(id);
      saveSession();
      renderMessageList();
      // Re-apply active state
      const activeEl = document.querySelector(`.message-item[data-id="${cssEscape(id)}"]`);
      if (activeEl) activeEl.classList.add('active');
    } catch (err) {
      console.error('Open message failed:', err);
      viewer.innerHTML = `
        <div class="viewer-empty">
          <div class="viewer-empty-icon">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h2>Could not load message</h2>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  function renderMessageDetail(m) {
    const viewer = $('emailViewer');
    const senderName = m.from && m.from.name ? m.from.name : '';
    const senderEmail = m.from && m.from.address ? m.from.address : 'Unknown';
    const subject = m.subject || '(no subject)';
    const date = formatFullDate(m.createdAt);
    const intro = m.intro ? `<p style="color:var(--text-2);font-style:italic;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border);">${escapeHtml(m.intro)}</p>` : '';

    viewer.innerHTML = `
      <div class="email-detail">
        <div class="email-detail-header">
          <h1>${escapeHtml(subject)}</h1>
          <div class="email-meta">
            <div class="meta-row">
              <div class="meta-avatar">${escapeHtml(getInitials(senderEmail))}</div>
              <div class="meta-info">
                <div class="meta-sender">
                  ${senderName ? `<strong>${escapeHtml(senderName)}</strong>` : ''}
                  <span class="meta-email">&lt;${escapeHtml(senderEmail)}&gt;</span>
                </div>
                <div class="meta-date">${escapeHtml(date)}</div>
              </div>
            </div>
            <div class="meta-row" style="padding-left:52px;">
              <span style="color:var(--text-3);font-size:12px;">To:</span>
              <span style="color:var(--text-1);font-size:12px;">${escapeHtml(state.email || '')}</span>
            </div>
          </div>
        </div>
        <div class="email-body">
          ${intro}
          ${buildBodyHtml(m)}
        </div>
      </div>
    `;
  }

  function closeReader() {
    state.selectedMessageId = null;
    $('emailViewer').classList.remove('show-mobile');
    $$('.message-item').forEach((el) => el.classList.remove('active'));
    $('emailViewer').innerHTML = `
      <div class="viewer-empty">
        <div class="viewer-empty-icon">
          <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        </div>
        <h2>Select a message</h2>
        <p>Choose an email from the inbox to read it here.</p>
      </div>
    `;
  }

  /* ---------- POLLING & COUNTDOWN ---------- */
  function startInbox() {
    refreshInbox(true);
    state.refreshTimer = setInterval(() => refreshInbox(true), REFRESH_INTERVAL);

    state.countdown = 5;
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(() => {
      state.countdown--;
      if (state.countdown <= 0) state.countdown = 5;
      const el = $('countdownNum');
      if (el) el.textContent = state.countdown;
    }, 1000);
  }

  function stopInbox() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.refreshTimer = state.countdownTimer = null;
  }

  /* ---------- COPY EMAIL ---------- */
  async function copyEmail() {
    if (!state.email) {
      return showToast('No inbox yet', 'error');
    }
    try {
      await navigator.clipboard.writeText(state.email);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = state.email;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
    showToast('Email copied to clipboard', 'success');
  }

  /* ---------- LOGOUT (DELETE INBOX) ---------- */
  async function handleLogout() {
    const ok = await confirmDialog(
      'Delete this inbox?',
      'This will permanently delete your temporary email address and all its messages. This cannot be undone.'
    );
    if (!ok) return;

    stopInbox();
    closeReader();
    await deleteAccount();
    clearSession();
    $('currentEmail').textContent = '—';
    $('inboxCount').textContent = '0';
    $('messageList').innerHTML = '';
    $('emptyInbox').classList.remove('hidden');
    showAuthPage();
    showToast('Inbox deleted', 'success');
  }

  /* ---------- EVENT BINDING ---------- */
  function bindEvents() {
    // Tab switching
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentTab = tab.dataset.tab;
        $('authSubmit').querySelector('.btn-text').textContent =
          state.currentTab === 'signup' ? 'Sign Up' : 'Sign In';
        clearAuthError();
      });
    });

    $('authForm').addEventListener('submit', handleAuthSubmit);

    $('googleBtn').addEventListener('click', () => {
      showToast('Google sign-in is a demo placeholder — use Skip for a real inbox.');
    });

    $('skipBtn').addEventListener('click', generateInbox);

    // Inbox actions
    $('copyEmailBtn').addEventListener('click', copyEmail);
    $('refreshBtn').addEventListener('click', () => refreshInbox(false));
    $('deleteBtn').addEventListener('click', handleLogout);
    $('logoutBtn').addEventListener('click', handleLogout);

    // Search
    $('searchInput').addEventListener('input', renderMessageList);

    // Esc closes mobile viewer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selectedMessageId) closeReader();
    });
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  /* ---------- BOOT ---------- */
  function init() {
    bindEvents();

    const saved = loadSession();
    if (saved && saved.token && saved.email) {
      state.token = saved.token;
      state.accountId = saved.accountId;
      state.email = saved.email;
      state.password = saved.password;
      state.domain = saved.domain;
      state.seenIds = new Set(saved.seenIds || []);
      // Verify token still works
      fetchMessages()
        .then(() => showInboxPage())
        .catch((err) => {
          if (err.status === 401) {
            clearSession();
            showAuthPage();
          } else {
            // Network error — allow UI anyway, will retry
            showInboxPage();
          }
        });
    } else {
      showAuthPage();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
