// Real headlines for Hubie's quiet moments: football, crypto, tech, gaming.
// Pulled from public RSS feeds every 30 min. Hubie only retells what the headline says.
// Anything about politics, war, death, crime or tragedy is skipped.
'use strict';
const fs = require('fs'), path = require('path');

const FEEDS = [
  { topic: 'football', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { topic: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { topic: 'crypto', url: 'https://cointelegraph.com/rss' },
  { topic: 'tech', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { topic: 'tech', url: 'https://www.theverge.com/rss/index.xml' },
  { topic: 'gaming', url: 'https://www.pcgamer.com/rss/' },
  { topic: 'gaming', url: 'https://www.gamespot.com/feeds/game-news' },
];
const SKIP = /\b(kill(s|ed|ing)?|dead|dies|died|death|murder\w*|shoot\w*|stab\w*|attack\w*|war|wars|bomb\w*|terror\w*|suicide|abuse\w*|assault\w*|rape|crash(ed|es)?|accident|tragedy|funeral|injur\w*|hospital|cancer|disease|arrest\w*|police|court|trial|jail|prison|sentenc\w*|charged|lawsuit|sued|fraud|scam\w*|hack(ed|ers?)?|stolen|theft|exploit\w*|elect\w*|president|minister|government|parliament|trump|biden|putin|israel|gaza|ukraine|russia|iran|sanction\w*|tariff\w*|protest\w*|racis\w*|sex\w*|porn|betting|bet|odds|tips|predict\w*|gambl\w*|casino|layoff\w*|redundan\w*)\b/i;

const clean = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
  .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-').replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? clean(m[1]) : ''; };

function parse(xml, topic) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 15)) {
    const title = tag(b, 'title');
    const summary = (tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 240);
    const when = Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated')) || Date.now();
    if (!title || title.length < 15) continue;
    if (SKIP.test(title) || SKIP.test(summary)) continue;
    if (Date.now() - when > 3 * 24 * 3600e3) continue;              // only the last 3 days
    out.push({ topic, title, summary, when });
  }
  return out;
}

module.exports = function news({ dataDir, log }) {
  const USED = path.join(dataDir, 'news-used.json');
  let used = []; try { used = JSON.parse(fs.readFileSync(USED, 'utf8')); } catch {}
  let items = [], lastTopic = '';
  async function refresh() {
    const all = [];
    for (const f of FEEDS) {
      try {
        const r = await fetch(f.url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (HubieStream news reader)' } });
        if (r.ok) all.push(...parse(await r.text(), f.topic));
      } catch {}
    }
    const seen = new Set();
    items = all.filter(i => { const k = i.title.toLowerCase(); if (seen.has(k) || used.includes(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.when - a.when);
    log(`[news] ${items.length} fresh headlines (${[...new Set(items.map(i => i.topic))].join(', ') || 'none'})`);
  }
  refresh(); setInterval(refresh, 30 * 60e3);
  return {
    // next headline, rotating topics so it isn't all football
    next() {
      if (!items.length) return null;
      let i = items.findIndex(x => x.topic !== lastTopic); if (i < 0) i = 0;
      const it = items.splice(i, 1)[0]; lastTopic = it.topic;
      used.push(it.title.toLowerCase()); if (used.length > 300) used = used.slice(-300);
      try { fs.writeFileSync(USED, JSON.stringify(used)); } catch {}
      return it;
    },
    top: n => items.slice(0, n),
    count: () => items.length,
  };
};
