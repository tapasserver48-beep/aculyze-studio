/**
 * Local store — entities: User, Conversation, Message, Model, Provider, Settings.
 * v1 uses localStorage (no cloud auth). Keys are namespaced `zara:*`.
 */

const K_CONV = 'zara:conversations:v1';
const K_SETTINGS = 'zara:settings:v1';

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem(K_CONV);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveConversations(convs) {
  try {
    localStorage.setItem(K_CONV, JSON.stringify(convs));
  } catch { /* quota — ignore */ }
}

export function createConversation(title = 'New chat') {
  const now = new Date().toISOString();
  return { id: uid('conv'), title, createdAt: now, updatedAt: now, messages: [] };
}

export function autoTitleFrom(text, maxLen = 42) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New chat';
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine;
}

export function groupConversations(convs) {
  const sorted = [...convs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const groups = { Today: [], Yesterday: [], 'Previous 7 Days': [], Older: [] };
  for (const c of sorted) {
    const d = new Date(c.updatedAt);
    if (d >= startOfToday) groups['Today'].push(c);
    else if (d >= startOfYesterday) groups['Yesterday'].push(c);
    else if (d >= weekAgo) groups['Previous 7 Days'].push(c);
    else groups['Older'].push(c);
  }
  return groups;
}

const DEFAULT_SETTINGS = {
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
  theme: 'light', // light | dark | system
  compact: false,
  animations: true, // micro-interactions / motion
  webSearch: false, // answer with keyless web results
  voiceReplies: false, // speak replies aloud (AI voice when online, browser voice otherwise)
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(K_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(K_SETTINGS, JSON.stringify(s));
  } catch { /* ignore */ }
}
