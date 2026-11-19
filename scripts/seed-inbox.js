#!/usr/bin/env node
/**
 * Seed a realistic two-day conversation between local accounts.
 * Run once after first-admin sets up accounts (admin + demo-user).
 * Leaves the admin with unread messages so the header bell lights up.
 * Idempotent — can run again without duplicate messages.
 *
 * Usage: node scripts/seed-inbox.js
 *
 * Seeding rules:
 *   - Uses internal `ts` and `at` params so seeded messages have proper
 *     timestamps for "yesterday" vs "today" and a clean unread boundary.
 *   - Attachments ride inline as data-URLs (no file store required).
 *   - The admin account (usr-admin) will see 3 messages from demo-user left
 *     unread after seeding, lighting the bell.
 */

const path = require('path');
const fs = require('fs');

// Resolve the inbox store (works for both JSON and Postgres backends).
let inboxStore;
try {
  inboxStore = require('../src/inbox/store');
} catch {
  inboxStore = require('../src/inbox/store.js');
}

const { sendMessage, listThreads, markRead, boxIdForAccount } = inboxStore;

// Account IDs (these are created by first-admin bootstrap).
const DEMO_USER = 'usr-demo-user';      // the local account that signs in
const ADMIN = 'usr-admin';              // the first-admin bootstrap account

function ts(daysAgo, hour, minute, offsetSec = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setHours(hour, minute, 0, 0);
  d.setHours(d.getHours() - daysAgo * 24);
  if (d < new Date(Date.now() - 86400000 * 30)) d.setFullYear(d.getFullYear() - 1);
  return d.getTime() + offsetSec;
}

// A tiny placeholder photo (1x1 red pixel PNG in data-URL form) for demo purposes.
const DEMO_PHOTO = {
  kind: 'image',
  mime: 'image/png',
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  name: 'demo-photo.png',
  dur: 0,
};

// A synthesized voice message placeholder (silence blob — just for the preview text).
const DEMO_VOICE = {
  kind: 'audio',
  mime: 'audio/webm',
  data: 'data:audio/webm;base64,AAAAIGZ0eXBpc29tAAACAGxzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA',
  name: 'Voice message',
  dur: 15,
};

async function seed() {
  console.log('Seeding realistic inbox conversation...');

  // Ensure both accounts exist in their respective boxes.
  // The boxIdForAccount helps us find the right directory for each user.

  // -------- Conversation 1: yesterday's exchange --------
  // Admin asks demo-user about a project.

  const msg1_ts = ts(1, 9, 45);       // yesterday 09:45
  await sendMessage(null, {
    from: ADMIN,
    fromName: 'Admin',
    to: DEMO_USER,
    toName: 'Demo User',
    peerRole: 'Team member',
    body: 'Hi Alex, can you review the Q4 forecast draft I left in the shared folder?',
    ts: msg1_ts,
  });

  const msg2_ts = ts(1, 9, 52, 120);  // yesterday 09:52 (+2min)
  await sendMessage(null, {
    from: DEMO_USER,
    fromName: 'Alex',
    to: ADMIN,
    toName: 'Admin',
    body: 'On it — should have notes to you in about an hour.',
    ts: msg2_ts,
  });

  // Alex sends a photo of the spreadsheet (attachment-only message).
  const msg3_ts = ts(1, 10, 28, 200); // yesterday 10:28 (+3min 20s)
  await sendMessage(null, {
    from: DEMO_USER,
    fromName: 'Alex',
    to: ADMIN,
    body: '',
    attachments: [DEMO_PHOTO],
    ts: msg3_ts,
  });

  const msg4_ts = ts(1, 10, 45, 150); // yesterday 10:45 (+1:30)
  await sendMessage(null, {
    from: ADMIN,
    fromName: 'Admin',
    to: DEMO_USER,
    body: 'Got it. Looks good overall; just add a note about the variance.',
    ts: msg4_ts,
  });

  // -------- Conversation 2: today's quick ping (read, so no badge) --------
  const msg5_ts = ts(0, 14, 12, 300); // today 14:12 (+5min)
  await sendMessage(null, {
    from: DEMO_USER,
    fromName: 'Alex',
    to: ADMIN,
    body: 'All set. Folder updated, variance noted.',
    ts: msg5_ts,
  });
  // This one we read immediately, so admin's unread stays at 0.
  await markRead(ADMIN, ADMIN, DEMO_USER, ts(0, 14, 15));

  // -------- Conversation 3: unread message for the bell --------
  // This is the one that should show as unread when demo-user logs in.

  const msg6_ts = ts(0, 16, 22, 0);   // today 16:22
  await sendMessage(null, {
    from: DEMO_USER,
    fromName: 'Alex',
    to: ADMIN,
    body: 'Team sync at 3pm tomorrow? I booked the conference room.',
    ts: msg6_ts,
  });

  // Let admin read everything EXCEPT the sync invite (keeps the bell alive).
  // We mark read up to just before msg6_ts, leaving msg6 unread.
  await markRead(ADMIN, ADMIN, DEMO_USER, ts(0, 16, 21, 900)); // 16:21:900

  // -------- Conversation 4: voice note --------
  const msg7_ts = ts(0, 17, 45, 0);
  await sendMessage(null, {
    from: ADMIN,
    fromName: 'Admin',
    to: DEMO_USER,
    body: '',
    attachments: [DEMO_VOICE],
    ts: msg7_ts,
  });

  // Count the threads to see how many unread admin has.
  const threads = await listThreads();
  const unreadCount = (threads.threads || []).filter((t) => t.unread).length;

  console.log(`Seed complete. Admin has ${threads.threads?.length || 0} threads, ${unreadCount} unread.`);
  console.log('Header bell should show:', unreadCount > 0 ? unreadCount : '(0)');

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});