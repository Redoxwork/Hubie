// Gemini (Flash-Lite) call that always answers as JSON {say, mood}. Returns null on any failure so the caller can fall back.
'use strict';
const MOODS = ['neutral', 'happy', 'laugh', 'excited', 'sad', 'shocked', 'thinking'];

module.exports = ({ log }) => {
  const key = process.env.GEMINI_API_KEY;
  let model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const backup = process.env.GEMINI_BACKUP_MODEL || 'gemini-3.5-flash';
  let backoffUntil = 0, fails = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function ask(system, prompt, retried, useModel) {
    if (!key || Date.now() < backoffUntil) return null;
    const m0 = useModel || model;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m0}:generateContent`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: 300, responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { say: { type: 'STRING' }, mood: { type: 'STRING', enum: MOODS },
              reply_to: { type: 'STRING' },
              remember: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, fact: { type: 'STRING' } }, required: ['name', 'fact'] } } },
              required: ['say', 'mood'] } },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // model retired? Google's error names the replacement: switch to it and retry once
        const named = r.status === 404 ? [...String(j.error?.message || '').matchAll(/models\/([\w.-]+[\w])/g)].map(m => m[1]) : [];
        const next = named[named.length - 1];
        if (next && next !== model && !retried) { log(`llm: model ${model} retired, switching to ${next}`); model = next; return ask(system, prompt, true); }
        if (r.status === 503 || r.status === 500) {          // Google busy: quick retry, then the backup model
          if (!useModel && !retried) { await sleep(800); return ask(system, prompt, 'busy'); }
          if (retried === 'busy' && backup !== model) { log(`llm: ${model} busy, trying ${backup}`); return ask(system, prompt, 'backup', backup); }
        }
        fails++;
        backoffUntil = Date.now() + (r.status === 429 ? 60e3 : Math.min(60e3, 5e3 * fails));
        log('llm: error', r.status, JSON.stringify(j.error?.message || j).slice(0, 160));
        return null;
      }
      fails = 0;
      const o = JSON.parse((j.candidates?.[0]?.content?.parts || []).map(p => p.text).join(''));
      return o && typeof o.say === 'string' ? { say: o.say, mood: MOODS.includes(o.mood) ? o.mood : 'neutral',
        reply_to: typeof o.reply_to === 'string' ? o.reply_to : '', remember: Array.isArray(o.remember) ? o.remember.slice(0, 3) : [] } : null;
    } catch (e) {
      fails++; backoffUntil = Date.now() + Math.min(60e3, 5e3 * fails);
      log('llm: fail', e.message); return null;
    } finally { clearTimeout(t); }
  }
  return { ask, enabled: !!key, healthy: () => !!key && fails === 0, get model() { return model; }, MOODS };
};
