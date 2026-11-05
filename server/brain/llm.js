// Gemini (Flash-Lite) call that always answers as JSON {say, mood}. Returns null on any failure so the caller can fall back.
'use strict';
const MOODS = ['neutral', 'happy', 'laugh', 'excited', 'sad', 'shocked', 'thinking'];

module.exports = ({ log }) => {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  let backoffUntil = 0, fails = 0;

  async function ask(system, prompt) {
    if (!key || Date.now() < backoffUntil) return null;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: 200, responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { say: { type: 'STRING' }, mood: { type: 'STRING', enum: MOODS } },
              required: ['say', 'mood'] } },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        fails++;
        backoffUntil = Date.now() + (r.status === 429 ? 60e3 : Math.min(60e3, 5e3 * fails));
        log('llm: error', r.status, JSON.stringify(j.error?.message || j).slice(0, 160));
        return null;
      }
      fails = 0;
      const o = JSON.parse((j.candidates?.[0]?.content?.parts || []).map(p => p.text).join(''));
      return o && typeof o.say === 'string' ? { say: o.say, mood: MOODS.includes(o.mood) ? o.mood : 'neutral' } : null;
    } catch (e) {
      fails++; backoffUntil = Date.now() + Math.min(60e3, 5e3 * fails);
      log('llm: fail', e.message); return null;
    } finally { clearTimeout(t); }
  }
  return { ask, enabled: !!key, model, MOODS };
};
