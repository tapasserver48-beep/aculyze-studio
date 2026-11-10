/**
 * Zara Orchestrator — YouTube / visual workflow executor.
 *
 * Runs the controlled visual loop against the LOCAL browser automation service
 * (Playwright). Each workflow is a fixed, hardcoded sequence of WHITELISTED
 * browser ops — the caller only ever passes a search query (plain text), never
 * a selector, URL, or code. Every step follows PLAN → ACTION → VERIFY, one
 * action at a time, and stops honestly the moment a target cannot be found or
 * a verification fails.
 *
 * Safety (Level 1 — no confirmation needed for public playback):
 *   opening Chrome, opening YouTube, searching YouTube, clicking a public
 *   video, play, pause, scrolling. Nothing here buys, sends, submits,
 *   deletes, or touches credentials.
 *
 * No blind coordinate clicks: the "click" steps resolve a visible target by
 * role + text via the deterministic find_visible op, and re-capture the screen
 * to verify the result before continuing.
 */

const svc = require('../automation/browserService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const YOUTUBE_RESULTS = 'https://www.youtube.com/results?search_query=';

function buildResultsUrl(query) {
  return `${YOUTUBE_RESULTS}${encodeURIComponent(String(query || '').trim())}`;
}

/**
 * Run a workflow. Returns { steps, context, ok, notice }.
 *   steps   : [{ id, text, ok }]  — displayed in the chat as ● → ✓ / ⚠
 *   context : guidance for the LLM's final natural-language reply
 *   ok      : overall success
 */
async function run(message, { workflow, query } = {}) {
  const steps = [];
  let ok = false;
  let context = null;
  let notice = null;

  const push = (id, text, good) => { steps.push({ id, text, ok: !!good }); };

  // Small, fixed action budget — never an unbounded autonomous loop.
  const MAX_ACTIONS = 10;

  async function step(id, progressText, action, args, verify, doneText, ctxText) {
    if (steps.length >= MAX_ACTIONS) {
      push(id, '⚠ Stopping — reached the safe action limit for one request.', false);
      return false;
    }
    push(id, progressText, false); // ● in-progress marker (replaced below)
    let r;
    try {
      r = await svc.call(action, args || {});
    } catch (err) {
      r = { ok: false, error: err.message, code: err.code };
    }
    if (!r || !r.ok) {
      const msg = (r && r.error) || 'that step failed';
      steps[steps.length - 1] = { id, text: `⚠ ${progressText.replace(/^●\s*/, '')} — ${msg}`, ok: false };
      context = `The YouTube/visual step "${progressText}" could not complete (${msg}). `
        + 'Tell the user honestly and briefly what did not work. Do NOT claim the video played.';
      return false;
    }
    if (verify) {
      const v = verify(r) || {};
      if (v.failed) {
        steps[steps.length - 1] = { id, text: `⚠ ${v.failed}`, ok: false };
        context = v.context || 'Tell the user honestly that the expected result could not be verified. Do not guess.';
        return false;
      }
    }
    steps[steps.length - 1] = { id, text: doneText(r), ok: true };
    if (ctxText) context = ctxText(r);
    return true;
  }

  switch (workflow) {
    case 'youtube.open': {
      ok = await step('yt-open', '● Opening Chrome…', 'open', {},
        null,
        () => '✓ Chrome is open.',
        () => 'Chrome is open. Give a SHORT confirmation.');
      break;
    }

    case 'youtube.search': {
      ok = await step('yt-open', '● Opening Chrome…', 'open', {},
        null, () => '✓ Chrome is open.', null);
      if (ok) {
        ok = await step('yt-nav', `● Opening YouTube search for “${query}”…`, 'navigate', { url: buildResultsUrl(query) },
          (r) => (/youtube\.com\/results/.test(r.url || '') ? {} : { failed: 'YouTube search results did not load', context: 'YouTube search results did not load. Say so briefly.' }),
          () => `✓ YouTube search for “${query}” is open.`,
          () => `YouTube search results for “${query}” are on screen. Offer to play a video.`);
      }
      break;
    }

    case 'youtube.play': {
      // 1. open Chrome
      ok = await step('yt-open', '● Opening Chrome…', 'open', {},
        null, () => '✓ Chrome is open.', null);
      // 2. navigate to the results page
      if (ok) {
        ok = await step('yt-nav', `● Searching YouTube for “${query}”…`, 'navigate', { url: buildResultsUrl(query) },
          (r) => (/youtube\.com\/results/.test(r.url || '') ? {} : { failed: 'YouTube search results did not load', context: 'YouTube search results did not load. Say so briefly.' }),
          () => `✓ Found YouTube results for “${query}”.`, null);
      }
      // 3. capture + identify the first visible video result
      if (ok) {
        ok = await step('yt-find', '● Looking for the first video…', 'find_visible', { role: 'result' },
          (r) => (r.found ? {} : { failed: "I couldn't reliably identify a video result", context: "I couldn't reliably identify a video on the results page. Tell the user honestly. Do not guess or click randomly." }),
          (r) => `✓ Identified video: ${r.label || 'first result'}.`, null);
      }
      // 4. click it (identified target, then re-capture to verify)
      if (ok) {
        ok = await step('yt-click', '● Playing the first video…', 'click_visible', { role: 'result' },
          (r) => (r.found ? {} : { failed: 'the video could not be clicked', context: 'The video could not be clicked. Say so briefly.' }),
          () => '✓ Opened the video.', null);
      }
      // 5. verify the player is present and playing (start it if needed)
      if (ok) {
        await sleep(1500); // let the player load before we verify
        ok = await step('yt-verify', '● Verifying playback…', 'video_state', {},
          (r) => (r.present ? {} : { failed: 'no video player was found on the page', context: 'The video page loaded but no player was detected. Tell the user honestly.' }),
          (r) => (r.playing ? '✓ Video is playing.' : '⚠ Video opened but is not auto-playing.'),
          (r) => (r.playing
            ? `The video “${r.title || query}” is playing. Give a SHORT confirmation.`
            : `The video “${r.title || query}” is open but did not auto-play. Tell the user it is open.`));
        // If present but not playing, try one play action.
        if (ok) {
          const last = steps[steps.length - 1];
          if (!last.ok || /not auto-play/.test(last.text)) {
            const playOk = await step('yt-play', '● Starting playback…', 'video_control', { action: 'play' },
              (r) => (r.playing ? {} : { failed: 'the video did not start playing', context: 'The video did not start playing. Say so briefly.' }),
              () => '✓ Video is playing.',
              (r) => `The video “${r.title || query}” is now playing. Give a SHORT confirmation.`);
            ok = playOk;
          }
        }
      }
      break;
    }

    case 'youtube.pause': {
      ok = await step('yt-pause', '● Pausing the video…', 'video_control', { action: 'pause' },
        (r) => (!r.present ? { failed: 'there is no video open to pause', context: 'There is no video currently open to pause. Tell the user briefly.' }
          : (r.paused ? {} : { failed: 'the video is still playing', context: 'The video is still playing — the pause did not take effect. Say so briefly.' })),
        () => '✓ Video paused.',
        () => 'The video is paused. Give a SHORT confirmation.');
      break;
    }

    case 'youtube.resume': {
      ok = await step('yt-resume', '● Resuming the video…', 'video_control', { action: 'play' },
        (r) => (!r.present ? { failed: 'there is no video open to resume', context: 'There is no video currently open to resume. Tell the user briefly.' }
          : (r.playing ? {} : { failed: 'the video did not resume', context: 'The video did not resume. Say so briefly.' })),
        () => '✓ Video resumed.',
        () => 'The video is playing again. Give a SHORT confirmation.');
      break;
    }

    case 'youtube.scroll': {
      // Scroll via keyboard (Page Down) — a normal navigation key, Level 1.
      ok = await step('yt-scroll', '● Scrolling down…', 'press', { key: 'PageDown' },
        null, () => '✓ Scrolled down.', () => 'Scrolled the page down. Give a SHORT confirmation.');
      break;
    }

    case 'youtube.click': {
      ok = await step('yt-click', '● Clicking the first visible video…', 'click_visible', { role: 'result' },
        (r) => (r.found ? {} : { failed: "I couldn't reliably identify a video to click", context: "I couldn't reliably identify a video to click. Tell the user honestly. Do not guess." }),
        () => '✓ Clicked the video.', null);
      if (ok) {
        await sleep(1500);
        await step('yt-verify', '● Verifying the player…', 'video_state', {},
          (r) => (r.present ? {} : { failed: 'no video player was found', context: 'The video page loaded but no player was detected. Tell the user honestly.' }),
          (r) => (r.playing ? '✓ Video is playing.' : '✓ Video is open.'),
          (r) => `The video “${r.title || 'the video'}” is ${r.playing ? 'playing' : 'open'}. Give a SHORT confirmation.`);
      }
      break;
    }

    default:
      notice = "I don't have a workflow for that yet.";
      context = 'The requested workflow is not implemented. Say so briefly.';
  }

  return { steps, context, ok, notice };
}

module.exports = { run };
