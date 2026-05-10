/**
 * CS2 Portfolio — Steam History Scanner Bookmarklet
 * Hosted at: https://tannerclayton96-hash.github.io/cs2-portfolio/bookmarklet.js
 *
 * Run on: steamcommunity.com/profiles/{steamid64}/inventoryhistory/
 *
 * What it does:
 *   1. Walks every page of your Steam inventory history (CS2 app 730)
 *   2. Finds every "Unlocked a container" event
 *   3. Extracts: date, item received, wear, rarity, case name
 *   4. Outputs JSON you paste into the CS2 Portfolio dashboard
 *
 * Install via the dashboard's Setup section.
 */

(function () {
  'use strict';

  if (window.__cs2bm) {
    alert('CS2 History Scanner is already running — wait for it to finish.');
    return;
  }
  window.__cs2bm = true;

  // ── Validate page ────────────────────────────────────────────────────
  if (!location.host.includes('steamcommunity.com') || !location.pathname.includes('inventoryhistory')) {
    window.__cs2bm = false;
    alert(
      'Open this bookmarklet on your Steam Inventory History page.\n\n' +
      'URL should look like:\n' +
      'steamcommunity.com/profiles/YOUR_STEAMID64/inventoryhistory/'
    );
    return;
  }

  const profileBase = location.origin + location.pathname.split('/inventoryhistory')[0];
  const HIST_URL = profileBase + '/inventoryhistory/';

  // ── Rarity: Steam name_color hex → our key ───────────────────────────
  const COLOR_RARITY = {
    'b0c3d9': 'milspec',    // Consumer Grade
    '5e98d9': 'milspec',    // Industrial Grade
    '4b69ff': 'milspec',    // Mil-Spec Grade
    '8847ff': 'restricted',
    'd32ce6': 'classified',
    'eb4b4b': 'covert',
    'e4ae39': 'knife',      // Extraordinary (knives/gloves)
    'caab05': 'knife',      // Contraband
    'ffd700': 'knife',
  };

  const WEAR_ABBR = {
    'Factory New':    'FN',
    'Minimal Wear':   'MW',
    'Field-Tested':   'FT',
    'Well-Worn':      'WW',
    'Battle-Scarred': 'BS',
  };

  function rarityFromColor(hex) {
    const c = (hex || '').replace('#', '').toLowerCase().slice(0, 6);
    return COLOR_RARITY[c] || 'milspec';
  }

  function rarityFromTags(tags) {
    const t = (tags || []).find(x => x.category === 'Rarity');
    return t ? rarityFromColor(t.color) : null;
  }

  function wearFromTags(tags) {
    const t = (tags || []).find(x => x.category === 'Exterior');
    return t ? (WEAR_ABBR[t.localized_tag_name] || '') : '';
  }

  function wearFromName(name) {
    for (const [k, v] of Object.entries(WEAR_ABBR)) {
      if (name.includes('(' + k + ')')) return v;
    }
    return '';
  }

  function stripWear(name) {
    return (name || '').replace(/\s*\([^)]+\)\s*$/, '').trim();
  }

  function toIsoDate(raw) {
    const s = (raw || '').replace(/\s+/g, ' ').trim();
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    const m = s.match(/(\w+\s+\d+,?\s*\d{4})/);
    return m ? new Date(m[1]).toISOString().slice(0, 10) : s.slice(0, 10);
  }

  // ── Build progress overlay ────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,.9)',
    'z-index:2147483647', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'color:#fff', 'font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif', 'gap:14px',
  ].join(';');
  overlay.innerHTML = [
    '<div style="font-size:22px;font-weight:700;letter-spacing:-.5px">🔍 CS2 History Scanner</div>',
    '<div id="__cs2bm_prog" style="color:#aaa;text-align:center;max-width:340px">Connecting to Steam…</div>',
    '<div style="width:320px;height:6px;background:#222;border-radius:3px;overflow:hidden">',
    '  <div id="__cs2bm_bar" style="height:100%;background:linear-gradient(90deg,#4b69ff,#8847ff);width:0%;transition:width .4s ease"></div>',
    '</div>',
    '<div id="__cs2bm_sub" style="font-size:12px;color:#555">0 case opens found so far</div>',
    '<button id="__cs2bm_cancel" style="margin-top:4px;padding:8px 22px;background:#333;border:1px solid #555;color:#ccc;border-radius:6px;cursor:pointer;font-size:13px">Cancel</button>',
  ].join('');
  document.body.appendChild(overlay);

  let cancelled = false;
  document.getElementById('__cs2bm_cancel').onclick = () => { cancelled = true; };

  function setProgress(msg, sub, pct) {
    const p = document.getElementById('__cs2bm_prog');
    const s = document.getElementById('__cs2bm_sub');
    const b = document.getElementById('__cs2bm_bar');
    if (p) p.textContent = msg;
    if (s) s.textContent = sub;
    if (b && pct != null) b.style.width = Math.min(95, pct) + '%';
  }

  // ── Fetch one page of history ─────────────────────────────────────────
  async function fetchPage(cursor) {
    const p = new URLSearchParams({ ajax: '1', l: 'english' });
    p.append('app[]', '730');
    if (cursor) {
      p.set('cursor[time]', cursor.time);
      p.set('cursor[time_frac]', cursor.time_frac);
      p.set('cursor[s]', cursor.s);
    }
    const r = await fetch(HIST_URL + '?' + p.toString(), {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error('Steam returned HTTP ' + r.status);
    return r.json();
  }

  // ── Extract items gained/lost from one history row ────────────────────
  function extractItems(rowEl, descLookup) {
    const gained = [], lost = [];

    const groups = rowEl.querySelectorAll('.tradehistory_items_plusminus');
    for (const grp of groups) {
      // sign is determined by first non-whitespace text node in the group
      let sign = '+';
      for (const node of grp.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t === '-') { sign = '-'; break; }
          if (t === '+') { sign = '+'; break; }
        }
      }

      const itemEls = grp.querySelectorAll('[data-classid]');
      for (const el of itemEls) {
        const classId  = el.dataset.classid  || '';
        const instId   = el.dataset.instanceid || '0';
        const key1     = classId + '_' + instId;
        const desc     = descLookup[key1] || descLookup[classId] || {};

        // Fall back to visible name text if descriptions didn't arrive yet
        const nameEl   = el.querySelector('[class*="item_name"]');
        const name     = desc.market_hash_name || desc.name || (nameEl && nameEl.textContent.trim()) || '';
        const color    = desc.name_color || '';
        const tags     = desc.tags || [];

        (sign === '+' ? gained : lost).push({ name, color, tags });
      }
    }

    return { gained, lost };
  }

  // ── Main scan loop ────────────────────────────────────────────────────
  async function run() {
    const caseOpens  = [];
    const descLookup = {};
    let cursor = null, page = 0;

    try {
      while (!cancelled) {
        page++;
        setProgress(
          'Page ' + page + ' — scanning…',
          caseOpens.length + ' case opens found so far',
          page * 4
        );

        const data = await fetchPage(cursor);

        if (!data.success) {
          throw new Error(data.error || 'Steam API returned success=false — are you logged in?');
        }

        // ── Merge item descriptions ──────────────────────────────────
        for (const appItems of Object.values(data.descriptions || {})) {
          for (const [key, desc] of Object.entries(appItems)) {
            descLookup[key] = desc;
            if (desc.classid) descLookup[desc.classid] = desc;
          }
        }

        // ── Parse HTML events ────────────────────────────────────────
        const doc  = new DOMParser().parseFromString(data.html || '', 'text/html');
        const rows = doc.querySelectorAll('.tradehistoryrow');

        for (const row of rows) {
          const descEl = row.querySelector('.tradehistory_event_description');
          if (!descEl) continue;

          const eventType = descEl.textContent.trim().toLowerCase();
          if (!eventType.includes('unlocked a container')) continue;

          // ── Date ────────────────────────────────────────────────
          const dateEl  = row.querySelector('.tradehistory_date');
          const dateRaw = dateEl ? dateEl.textContent.replace(/\s+/g, ' ').trim() : '';
          const date    = toIsoDate(dateRaw);

          // ── Items ───────────────────────────────────────────────
          const { gained, lost } = extractItems(row, descLookup);

          // The skin is the gained item that isn't a key or pass
          const skin = gained.find(i =>
            i.name && !/\bkey\b|\bpass\b/i.test(i.name)
          ) || gained[0];

          // The container is the lost item that looks like a case/capsule
          const container = lost.find(i =>
            /case|capsule|package/i.test(i.name)
          ) || lost.find(i => !/\bkey\b/i.test(i.name)) || lost[0];

          if (!skin || !skin.name) continue;

          const mhn    = skin.name;
          const rarity = rarityFromTags(skin.tags) || rarityFromColor(skin.color);
          const wear   = wearFromTags(skin.tags)   || wearFromName(mhn);

          caseOpens.push({
            date,
            item:     stripWear(mhn),
            wear,
            rarity,
            value:    0,
            caseName: container ? container.name : '',
          });
        }

        cursor = data.cursor || null;
        if (!cursor) break;

        // Polite pacing — ≤1 req/sec to avoid Steam rate limiting
        await new Promise(res => setTimeout(res, 1100));
      }
    } catch (err) {
      overlay.remove();
      window.__cs2bm = false;
      alert(
        'Error scanning history:\n' + err.message + '\n\n' +
        'Make sure you\'re logged into Steam and your inventory history is set to Public.'
      );
      return;
    }

    overlay.remove();
    window.__cs2bm = false;

    if (!caseOpens.length) {
      alert(
        cancelled
          ? 'Scan cancelled — no data was exported.'
          : 'No CS2 case opens found.\n\nMake sure your Steam Privacy Settings → Inventory is set to Public.'
      );
      return;
    }

    // ── Group into sessions by date ───────────────────────────────────
    const byDate = Object.create(null);
    for (const o of caseOpens) {
      if (!byDate[o.date]) byDate[o.date] = [];
      byDate[o.date].push({
        item:  o.item,
        wear:  o.wear,
        rarity: o.rarity,
        value: 0,
        case:  o.caseName,
      });
    }

    const sessions = Object.entries(byDate)
      .map(([date, pulls]) => ({ date, pulls }))
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first

    const golds = caseOpens
      .filter(o => o.rarity === 'knife')
      .map(o => ({
        type:      'knife',
        tag:       'Gold',
        name:      o.item,
        date:      o.date,
        source:    o.caseName,
        value:     0,
        floatVal:  '',
        odds:      '~1 in 385',
        costBasis: '—',
      }));

    const output = {
      _source:        'steam_history_bookmarklet',
      _generated:     new Date().toISOString().slice(0, 10),
      totalCaseOpens: caseOpens.length,
      cancelled,
      sessions,
      golds,
    };

    const json = JSON.stringify(output, null, 2);

    // ── Result modal ──────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.9)',
      'z-index:2147483647', 'display:flex', 'align-items:center', 'justify-content:center',
      'font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif',
    ].join(';');

    modal.innerHTML = [
      '<div style="background:#12121e;border:1px solid #2a2a3e;border-radius:12px;padding:28px;',
        'max-width:560px;width:92%;max-height:88vh;display:flex;flex-direction:column;gap:14px;">',
        '<div style="font-size:20px;font-weight:700;color:#fff">',
          '✅ ' + caseOpens.length + ' Case Opens Found',
        '</div>',
        '<div style="color:#888;font-size:12px;">',
          sessions.length + ' session days &nbsp;·&nbsp; ',
          golds.length + ' gold pull' + (golds.length !== 1 ? 's' : '') + ' &nbsp;·&nbsp; ',
          (cancelled ? '⚠ Scan cancelled early' : 'Full history scanned'),
        '</div>',
        '<div style="color:#ccc;font-size:12px;line-height:1.7;background:#1a1a2e;padding:10px 12px;border-radius:6px;">',
          '<strong style="color:#4b69ff">Next:</strong> Copy this JSON → open your CS2 Portfolio dashboard',
          ' → Setup → <strong>Steam History Import</strong> → Paste &amp; Import',
        '</div>',
        '<textarea id="__cs2bm_out" style="flex:1;min-height:200px;background:#0a0a12;color:#4fc3f7;',
          'border:1px solid #2a2a3e;border-radius:6px;padding:10px;font:11px/1.4 monospace;resize:vertical;" ',
          'readonly>' + json.replace(/</g, '&lt;') + '</textarea>',
        '<div style="display:flex;gap:10px;">',
          '<button id="__cs2bm_copy" style="flex:1;padding:12px;background:#4b69ff;border:none;color:#fff;',
            'border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Copy JSON</button>',
          '<button id="__cs2bm_close" style="padding:12px 20px;background:#222;border:1px solid #333;',
            'color:#ccc;border-radius:6px;cursor:pointer;font-size:14px;">Close</button>',
        '</div>',
      '</div>',
    ].join('');

    document.body.appendChild(modal);

    document.getElementById('__cs2bm_copy').addEventListener('click', function () {
      const ta = document.getElementById('__cs2bm_out');
      navigator.clipboard.writeText(ta.value).then(function () {
        const btn = document.getElementById('__cs2bm_copy');
        if (btn) {
          btn.textContent = '✓ Copied!';
          setTimeout(function () { if (btn) btn.textContent = 'Copy JSON'; }, 2500);
        }
      }).catch(function () {
        ta.select();
        document.execCommand('copy');
      });
    });

    document.getElementById('__cs2bm_close').addEventListener('click', function () {
      modal.remove();
    });
  }

  run();
})();
