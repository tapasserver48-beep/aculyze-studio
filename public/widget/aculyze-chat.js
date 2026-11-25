/*!
 * Aculyze website assistant widget (Phase 04.4).
 * <script src="https://YOUR-STUDIO/widget/aculyze-chat.js" data-key="pub_…" async></script>
 * Optional: data-color="#b45309" data-position="left"
 * Shadow DOM keeps the host page's CSS out; all text is escaped.
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-key][src*="aculyze-chat"]');
  if (!script || window.__aculyzeChatLoaded) return;
  window.__aculyzeChatLoaded = true;

  var KEY = script.getAttribute('data-key');
  if (!KEY) { console.warn('[aculyze-chat] missing data-key'); return; }
  var BASE = new URL(script.src).origin + '/api/customer/public/' + encodeURIComponent(KEY);
  var COLOR = script.getAttribute('data-color') || '#b45309';
  var LEFT = script.getAttribute('data-position') === 'left';
  var STORE = 'aculyze-chat:' + KEY;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load() { try { return JSON.parse(sessionStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify({ conversationId: state.conversationId, messages: state.messages.slice(-30), leadSent: state.leadSent })); } catch (e) { /* private mode */ } }

  var saved = load();
  var state = { open: false, busy: false, bot: null, conversationId: saved.conversationId || null, messages: saved.messages || [], leadSent: !!saved.leadSent, showLead: false };

  var host = document.createElement('div');
  host.setAttribute('data-aculyze-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var side = LEFT ? 'left' : 'right';
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.bubble{position:fixed;bottom:20px;' + side + ':20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:' + COLOR + ';color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.22);display:grid;place-items:center;z-index:2147483000;transition:transform .15s}' +
    '.bubble:hover{transform:scale(1.06)}.bubble:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
    '.panel{position:fixed;bottom:90px;' + side + ':20px;width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);background:#fff;color:#1f2937;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000}' +
    '.panel[hidden]{display:none}' +
    '.head{background:' + COLOR + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.head strong{font-size:15px}.head small{display:block;opacity:.85;font-size:12px;margin-top:2px}' +
    '.x{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}.x:focus-visible{outline:2px solid #fff}' +
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8f8fa}' +
    '.m{max-width:86%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.5;word-wrap:break-word}' +
    '.u{align-self:flex-end;background:' + COLOR + ';color:#fff;border-bottom-right-radius:4px}' +
    '.b{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}' +
    '.b a{color:' + COLOR + '}.cite{font-size:11px;font-weight:700;vertical-align:1px;text-decoration:none}' +
    '.src{margin:6px 0 0;padding:6px 0 0 18px;border-top:1px solid #eee;font-size:12px}.src li{margin:2px 0}' +
    '.typing{color:#6b7280;font-style:italic}' +
    '.lead{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:grid;gap:8px;font-size:13px}' +
    '.lead input[type=text],.lead input[type=email],.lead input[type=tel]{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px}' +
    '.lead label.c{display:flex;gap:6px;align-items:flex-start;font-size:12px;color:#4b5563}' +
    '.lead .err{color:#b91c1c;font-size:12px;margin:0}' +
    'form.in{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}' +
    'form.in input{flex:1;min-width:0;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:14px}' +
    'button.send,.lead button{background:' + COLOR + ';color:#fff;border:0;border-radius:10px;padding:0 14px;min-height:38px;font-size:14px;font-weight:600;cursor:pointer}' +
    'button:disabled{opacity:.6;cursor:default}' +
    '.foot{font-size:11px;color:#9ca3af;text-align:center;padding:0 0 8px;background:#fff}' +
    '@media (max-width:480px){.panel{bottom:0;' + side + ':0;width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0}}' +
    '</style>' +
    '<button class="bubble" type="button" aria-label="Open chat" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
    '<section class="panel" role="dialog" aria-label="Chat" hidden>' +
    '<div class="head"><div><strong class="name">Chat with us</strong><small>Answers from our website</small></div><button class="x" type="button" aria-label="Close chat">&times;</button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<form class="in"><label style="position:absolute;left:-9999px" for="q">Your message</label><input id="q" type="text" maxlength="1000" placeholder="Type your question…" autocomplete="off"><button class="send" type="submit">Send</button></form>' +
    '<div class="foot">Powered by Aculyze</div>' +
    '</section>';
  document.body.appendChild(host);

  var $ = function (s) { return root.querySelector(s); };
  var bubble = $('.bubble'), panel = $('.panel'), log = $('.log'), form = $('form.in'), input = $('#q');

  function api(path, body) {
    return fetch(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong'); return d; }); });
  }

  function answerHtml(m) {
    var sources = m.sources || [];
    var text = esc(m.content).replace(/\[(\d+)\]/g, function (x, n) {
      var s = sources[Number(n) - 1];
      return s ? '<a class="cite" href="' + esc(s.url) + '" target="_blank" rel="noopener">[' + n + ']</a>' : '';
    }).replace(/\n/g, '<br>');
    var list = sources.length ? '<ol class="src">' + sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a></li>'; }).join('') + '</ol>' : '';
    return text + list;
  }

  function render() {
    var html = '';
    if (state.bot && state.bot.description) html += '<div class="m b">' + esc(state.bot.description) + '</div>';
    state.messages.forEach(function (m) {
      html += m.role === 'user' ? '<div class="m u">' + esc(m.content) + '</div>' : '<div class="m b">' + answerHtml(m) + '</div>';
    });
    if (state.busy) html += '<div class="m b typing">Typing…</div>';
    if (state.showLead && !state.leadSent) {
      html += '<form class="lead"><strong>Leave your details and we\'ll get back to you</strong>' +
        '<input type="text" name="name" placeholder="Your name" maxlength="100" aria-label="Your name">' +
        '<input type="email" name="email" placeholder="Email" maxlength="200" aria-label="Email">' +
        '<input type="tel" name="phone" placeholder="Phone (optional)" maxlength="40" aria-label="Phone">' +
        '<label class="c"><input type="checkbox" name="consent"> <span>I agree to be contacted about my question.</span></label>' +
        '<p class="err" hidden></p><button type="submit">Send my details</button></form>';
    }
    log.innerHTML = html;
    log.scrollTop = log.scrollHeight;
    var lead = log.querySelector('form.lead');
    if (lead) lead.addEventListener('submit', sendLead);
  }

  function sendLead(e) {
    e.preventDefault();
    var f = e.currentTarget;
    var err = f.querySelector('.err');
    var email = f.email.value.trim(), phone = f.phone.value.trim();
    var consentText = f.querySelector('.c span').textContent;
    if (!email && !phone) { err.textContent = 'Please add an email or phone number.'; err.hidden = false; return; }
    if (!f.consent.checked) { err.textContent = 'Please tick the box so we can contact you.'; err.hidden = false; return; }
    f.querySelector('button').disabled = true;
    api('/leads', { name: f.name.value.trim(), email: email, phone: phone, consent: true, consentText: consentText, conversationId: state.conversationId })
      .then(function () {
        state.leadSent = true;
        state.showLead = false;
        state.messages.push({ role: 'assistant', content: 'Thank you! Someone from our team will get back to you soon.' });
        save(); render();
      })
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; f.querySelector('button').disabled = false; });
  }

  function send(text) {
    state.messages.push({ role: 'user', content: text });
    state.busy = true;
    render();
    api('/converse', { message: text, conversationId: state.conversationId })
      .then(function (d) {
        state.conversationId = d.conversationId || state.conversationId;
        state.messages.push({ role: 'assistant', content: d.response, sources: d.sourceDetails || [] });
        if (d.offerContact) state.showLead = true;
      })
      .catch(function (ex) { state.messages.push({ role: 'assistant', content: ex.message || 'Sorry, something went wrong. Please try again.' }); })
      .then(function () { state.busy = false; save(); render(); input.focus(); });
  }

  function toggle(open) {
    state.open = open;
    panel.hidden = !open;
    bubble.setAttribute('aria-expanded', String(open));
    bubble.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) {
      if (!state.bot) {
        api('').then(function (d) { state.bot = d.chatbot; $('.name').textContent = d.chatbot.name || 'Chat with us'; render(); }).catch(function (ex) {
          log.innerHTML = '<div class="m b">' + esc(ex.message || 'Chat is not available right now.') + '</div>';
        });
      }
      render();
      setTimeout(function () { input.focus(); }, 50);
    } else bubble.focus();
  }

  bubble.addEventListener('click', function () { toggle(!state.open); });
  $('.x').addEventListener('click', function () { toggle(false); });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) toggle(false); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = input.value.trim();
    if (!t || state.busy) return;
    input.value = '';
    send(t);
  });
})();
