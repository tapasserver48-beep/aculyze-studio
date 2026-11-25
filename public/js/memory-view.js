/**
 * Settings → Memory (Phase 04.4 Stage B): see, add, edit and delete what Zara
 * and the AI employees remember about you; switch learning on or off.
 */

import { memoryList, memoryAdd, memoryUpdate, memoryRemove, memoryClear, memorySettings } from './api.js';
import { escapeHtml as esc, relativeTime } from './work-ui.js';

const SOURCE = { manual: 'Added by you', zara: 'From Zara chat', inbox: 'From Inbox chat', task: 'From a task' };

export function initMemorySettings({ toast, confirm }) {
  const $ = (id) => document.getElementById(id);
  const list = $('memList');
  if (!list) return { load: () => {} };
  let items = [];
  let editing = null;

  function render() {
    $('memCount').textContent = items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} remembered` : '';
    $('memClear').hidden = !items.length;
    if (!items.length) {
      list.innerHTML = '<li class="mem-empty">Nothing yet. Tell Zara about your role or how you like answers, or add something above.</li>';
      return;
    }
    list.innerHTML = items.map((i) => (editing === i.id
      ? `<li class="mem-item is-editing" data-id="${esc(i.id)}">
          <label class="sr-only" for="memEdit-${esc(i.id)}">Edit memory</label>
          <input id="memEdit-${esc(i.id)}" class="mem-edit" type="text" maxlength="300" value="${esc(i.text)}">
          <div class="mem-actions"><button type="button" class="utility-primary" data-mem="save">Save</button><button type="button" class="utility-secondary" data-mem="cancel">Cancel</button></div>
        </li>`
      : `<li class="mem-item" data-id="${esc(i.id)}">
          <div class="mem-text"><p>${esc(i.text)}</p><small>${esc(SOURCE[i.source] || 'Remembered')} · ${esc(relativeTime(i.updatedAt))}</small></div>
          <div class="mem-actions">
            <button type="button" class="icon-btn ghost" data-mem="edit" aria-label="Edit: ${esc(i.text)}" title="Edit"><span class="material-symbols-outlined" aria-hidden="true">edit</span></button>
            <button type="button" class="icon-btn ghost" data-mem="delete" aria-label="Forget: ${esc(i.text)}" title="Forget"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button>
          </div>
        </li>`)).join('');
    if (editing) {
      const input = list.querySelector('.mem-edit');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }

  async function load() {
    try {
      const r = await memoryList();
      items = r.items || [];
      const sw = $('memAutoLearn');
      const on = !r.settings || r.settings.autoLearn !== false;
      sw.setAttribute('aria-checked', String(on));
      sw.querySelector('input').checked = on;
      render();
    } catch (err) {
      list.innerHTML = `<li class="mem-empty">${esc(err.message || 'Could not load your memory.')}</li>`;
    }
  }

  $('memAutoLearn').querySelector('input').addEventListener('change', async (e) => {
    const on = e.target.checked;
    $('memAutoLearn').setAttribute('aria-checked', String(on));
    try {
      await memorySettings({ autoLearn: on });
      toast(on ? 'Zara will learn from your chats' : 'Learning from chats is off');
    } catch (err) {
      toast(err.message, 'error');
      e.target.checked = !on;
      $('memAutoLearn').setAttribute('aria-checked', String(!on));
    }
  });

  $('memAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('memAddInput');
    const text = input.value.trim();
    if (!text) return;
    try {
      const r = await memoryAdd(text);
      input.value = '';
      toast(r.duplicate ? 'Updated a similar memory' : 'Remembered');
      load();
    } catch (err) { toast(err.message, 'error'); }
  });

  async function saveEdit(li) {
    const text = li.querySelector('.mem-edit').value.trim();
    if (!text) { toast('A memory cannot be empty', 'error'); return; }
    try {
      await memoryUpdate(li.dataset.id, text);
      editing = null;
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mem]');
    if (!btn) return;
    const li = btn.closest('.mem-item');
    const id = li.dataset.id;
    const act = btn.dataset.mem;
    if (act === 'edit') { editing = id; render(); return; }
    if (act === 'cancel') { editing = null; render(); return; }
    if (act === 'save') { saveEdit(li); return; }
    if (act === 'delete') {
      try {
        await memoryRemove(id);
        items = items.filter((i) => i.id !== id);
        render();
        toast('Forgotten');
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  list.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('mem-edit')) return;
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(e.target.closest('.mem-item')); }
    if (e.key === 'Escape') { editing = null; render(); }
  });

  $('memClear').addEventListener('click', async () => {
    const ok = await confirm({ title: 'Forget everything?', detail: `Zara and your AI employees will forget all ${items.length} things they remember about you. This can't be undone.`, okLabel: 'Forget everything' });
    if (!ok) return;
    try { await memoryClear(); items = []; render(); toast('Memory cleared'); } catch (err) { toast(err.message, 'error'); }
  });

  return { load };
}
