// Hubie's AI brain. Always answers as {say, mood, reply_to, remember}, or null so the caller can use a backup line.
// Order: Google Gemini (free tier) first, then OpenRouter (paid with crypto) whenever Google says no.
'use strict';
const MOODS = ['neutral', 'happy', 'laugh', 'excited', 'sad', 'shocked', 'thinking'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parse(raw, log) {
  let o;
  try { o = JSON.parse(String(raw).replace(/^```(json)?\s*|\s*```$/g, '')); } catch {
    // cut-off or messy answer: keep the "say" text if it's there
    const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw), md = /"mood"\s*:\s*"(\w+)"/.exec(raw);
    if (!m || m[1].length < 8) throw new Error('bad JSON from model');
    o = { say: m[1].replace(/\\"/g, '"').replace(/[^.!?]*$/, '') || m[1], mood: md ? md[1] : 'happy' };
    log('llm: repaired a cut-off answer');
  }
  return o && typeof o.say === 'string' ? { say: o.say, mood: MOODS.includes(o.mood) ? o.mood : 'neutral',
    reply_to: typeof o.reply_to === 'string' ? o.reply_to : '', remember: Array.isArray(o.remember) ? o.remember.slice(0, 3) : [] } : null;
}

module.exports = ({ log }) => {
  // ---------- Google Gemini ----------
  const gKey = process.env.GEMINI_API_KEY;
  let gModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const gBackup = process.env.GEMINI_BACKUP_MODEL || 'gemini-3.5-flash';
  let gPauseUntil = 0, gFails = 0;

  async function gemini(system, prompt, retried, useModel) {
    if (!gKey || Date.now() < gPauseUntil) return null;
    const m0 = useModel || gModel;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m0}:generateContent`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': gKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: 1024, responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { say: { type: 'STRING' }, mood: { type: 'STRING', enum: MOODS },
              reply_to: { type: 'STRING' },
              remember: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, fact: { type: 'STRING' } }, required: ['name', 'fact'] } } },
              required: ['say', 'mood'] } },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const named = r.status === 404 ? [...String(j.error?.message || '').matchAll(/models\/([\w.-]+[\w])/g)].map(m => m[1]) : [];
        const next = named[named.length - 1];
        if (next && next !== gModel && !retried) { log(`llm: model ${gModel} retired, switching to ${next}`); gModel = next; return gemini(system, prompt, true); }
        if (r.status === 503 || r.status === 500) {
          if (!useModel && !retried) { await sleep(800); return gemini(system, prompt, 'busy'); }
          if (retried === 'busy' && gBackup !== gModel) { log(`llm: ${gModel} busy, trying ${gBackup}`); return gemini(system, prompt, 'backup', gBackup); }
        }
        gFails++;
        // free-tier limit hit (429): rest Google for 10 min, OpenRouter covers meanwhile
        gPauseUntil = Date.now() + (r.status === 429 ? 10 * 60e3 : Math.min(60e3, 5e3 * gFails));
        log('llm: google error', r.status, JSON.stringify(j.error?.message || j).slice(0, 120));
        return null;
      }
      gFails = 0;
      return parse((j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''), log);
    } catch (e) {
      gFails++; gPauseUntil = Date.now() + Math.min(60e3, 5e3 * gFails);
      log('llm: google fail', e.message); return null;
    } finally { clearTimeout(t); }
  }

  // ---------- OpenRouter (backup, paid with crypto) ----------
  const oKey = process.env.OPENROUTER_API_KEY;
  const oModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
  let oPauseUntil = 0, oFails = 0, oUsed = 0;

  async function openrouter(system, prompt) {
    if (!oKey || Date.now() < oPauseUntil) return null;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${oKey}`, 'x-title': 'Hubie live 24/7' },
        body: JSON.stringify({
          model: oModel, temperature: 1.0, max_tokens: 400, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt + '\n\nReply with only the JSON object.' }],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        oFails++; oPauseUntil = Date.now() + (r.status === 402 ? 30 * 60e3 : Math.min(60e3, 5e3 * oFails));
        log('llm: openrouter error', r.status, JSON.stringify(j.error?.message || j).slice(0, 120), r.status === 402 ? '(out of credit?)' : '');
        return null;
      }
      oFails = 0;
      if (++oUsed % 50 === 1) log(`llm: using openrouter backup (${oUsed} calls so far)`);
      return parse(j.choices?.[0]?.message?.content || '', log);
    } catch (e) {
      oFails++; oPauseUntil = Date.now() + Math.min(60e3, 5e3 * oFails);
      log('llm: openrouter fail', e.message); return null;
    } finally { clearTimeout(t); }
  }

  async function ask(system, prompt) {
    return (await gemini(system, prompt)) || (await openrouter(system, prompt));
  }
  const healthy = () => (gKey && Date.now() >= gPauseUntil && gFails === 0) || (oKey && Date.now() >= oPauseUntil && oFails === 0);
  return { ask, enabled: !!(gKey || oKey), healthy, get model() { return gKey ? gModel + (oKey ? ' + openrouter' : '') : oModel; }, MOODS };
};
