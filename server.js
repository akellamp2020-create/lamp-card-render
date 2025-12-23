const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeTableBlock(block) {
  if (!block) return null;

  const title = String(block.title || '');
  const scheme = String(block.scheme || (title === 'Розмін' ? 'rozmin' : 'normal'));

  const rows = Array.isArray(block.rows) ? block.rows : [];
  return {
    title,
    scheme,
    rows: rows.map(r => {
      const values = Array.isArray(r.values) ? r.values : [];
      const times  = Array.isArray(r.times) ? r.times : [];
      return {
        values: values.map(v => ({
          text: String(v?.text ?? ''),
          cls: String(v?.cls ?? 'zero')
        })),
        times: times.map(t => ({ text: String(t?.text ?? '') }))
      };
    })
  };
}

function parsePipeList(str) {
  return String(str || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Legacy details -> block
 * rozmin: first + last = pos, middle = neg (как на сайте)
 * normal: всё zero/pos по желанию
 */
function legacyDetailsToBlock(title, detailsStr, scheme) {
  const parts = parsePipeList(detailsStr);
  if (!parts.length) return null;

  const sch = scheme || 'normal';
  const last = parts.length - 1;

  return {
    title,
    scheme: sch,
    rows: [
      {
        values: parts.map((text, idx) => {
          if (sch === 'rozmin') {
            return { text, cls: (idx === 0 || idx === last) ? 'pos' : 'neg' };
          }
          // для "Розрахунок" (legacy) сделаем зелёным
          return { text, cls: 'pos' };
        }),
        times: []
      }
    ]
  };
}

function htmlFromPayload(p) {
  // NEW payload (blocks)
  const blocks = p?.blocks || {};
  const result = blocks?.result || null;

  let rozmin = normalizeTableBlock(blocks?.rozmin);
  let rozrah = normalizeTableBlock(blocks?.rozrahunok);

  // legacy fallback for Result card
  const fallbackResult = (!result && (p?.name || p?.labelRozmin || p?.labelRozrah || p?.labelDebt)) ? {
    title: 'Результат',
    scheme: 'normal',
    name: String(p?.name ?? ''),
    rows: [
      { key: String(p?.labelRozmin ?? 'Розмін'), value: String(p?.valueRozmin ?? ''), cls: 'pos' },
      { key: String(p?.labelRozrah ?? 'Розрахунок'), value: String(p?.valueRozrah ?? ''), cls: 'pos' },
      { key: String(p?.labelDebt ?? 'Підсумок'), value: String(p?.valueDebt ?? ''), cls: 'pos' },
    ]
  } : null;

  const R = result || fallbackResult;

  // ✅ legacy fallback for tables (detailsRozmin/detailsRozrah)
  if (!rozmin && p?.detailsRozmin) {
    rozmin = legacyDetailsToBlock('Розмін', p.detailsRozmin, 'rozmin');
    rozmin = normalizeTableBlock(rozmin);
  }
  if (!rozrah && (p?.detailsRozrah || p?.valueRozrah)) {
    // если detailsRozrah нет, но есть valueRozrah — покажем его как единственную ячейку
    const src = p?.detailsRozrah ? p.detailsRozrah : String(p.valueRozrah);
    rozrah = legacyDetailsToBlock('Розрахунок', src, 'normal');
    rozrah = normalizeTableBlock(rozrah);
  }

  const css = `
    *{box-sizing:border-box}
    body{
      margin:0;
      background:#ffffff;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
      color:#111;
      padding:28px;
    }
    .wrap{ width:720px; margin:0 auto; }
    .card{
      border:1px solid #e9e9e9;
      border-radius:26px;
      padding:22px;
      background:#fff;
      margin:0 0 22px 0;
    }
    .title{ font-size:34px; font-weight:800; margin:0 0 14px 0; }
    .row{
      display:flex; justify-content:space-between; gap:16px;
      padding:18px 0; border-top:1px solid #f1f1f1; align-items:center;
    }
    .row:first-of-type{ border-top:0; padding-top:6px; }
    .k{ font-size:26px; color:#444; }
    .v{ font-size:34px; font-weight:800; }
    .pos{ color:#0a7a2f; }
    .neg{ color:#b00020; }
    .zero{ color:#111; }

    table{ width:100%; border-collapse:collapse; margin-top:12px; }
    th, td{
      padding:18px 10px; border-top:1px solid #f1f1f1;
      text-align:right; white-space:nowrap;
    }
    th{
      text-align:left; color:#111; font-size:26px; font-weight:800;
      background:#fafafa; border-top:0; padding:18px 10px;
    }
    td{ font-size:34px; font-weight:800; }
    .time td{
      font-weight:600; font-size:22px; color:#9a9a9a;
      padding-top:12px; padding-bottom:6px;
    }
  `;

  function renderResultCard() {
    if (!R) return '';
    const name = esc(R.name ?? '');
    const rows = Array.isArray(R.rows) ? R.rows : [];
    return `
      <div class="card">
        <div class="title">Результат</div>
        <div class="row"><div class="k">Ім'я</div><div class="v">${name}</div></div>
        ${rows.map(r => {
          const cls = String(r.cls || 'zero');
          return `<div class="row">
            <div class="k">${esc(r.key ?? '')}</div>
            <div class="v ${cls}">${esc(r.value ?? '')}</div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  // ✅ РИСУЕМ ВСЕ СТРОКИ block.rows + times
  function renderTableCard(block) {
    if (!block || !Array.isArray(block.rows) || block.rows.length === 0) return '';

    const title = esc(block.title || '');

    const maxCols = Math.max(
      1,
      ...block.rows.map(r => Array.isArray(r?.values) ? r.values.length : 0)
    );

    const header = `<tr><th>Разом</th>${
      Array.from({ length: Math.max(0, maxCols - 1) }, () => `<th></th>`).join('')
    }</tr>`;

    const body = block.rows.map(r => {
      const values = Array.isArray(r?.values) ? r.values : [];
      const times  = Array.isArray(r?.times) ? r.times : [];

      const valuesRow = `<tr>${
        Array.from({ length: maxCols }, (_, i) => {
          const c = values[i] || {};
          const cls = String(c?.cls || 'zero'); // ❗ НЕ инвертим
          return `<td class="${cls}">${esc(c?.text ?? '')}</td>`;
        }).join('')
      }</tr>`;

      const hasTimes = times.some(t => String(t?.text ?? '').trim() !== '');
      const timesRow = hasTimes ? `<tr class="time">${
        Array.from({ length: maxCols }, (_, i) => `<td>${esc(times[i]?.text ?? '')}</td>`).join('')
      }</tr>` : '';

      return valuesRow + timesRow;
    }).join('');

    return `
      <div class="card">
        <div class="title">${title}</div>
        <table>
          <thead>${header}</thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><style>${css}</style></head>
<body>
  <div class="wrap">
    ${renderResultCard()}
    ${renderTableCard(rozmin)}
    ${renderTableCard(rozrah)}
  </div>
</body>
</html>`;
}

/* ---------- HEALTH ---------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------- ROOT ---------- */
app.get('/', (req, res) => res.type('text').send('LAMP renderer OK ✅\nUse POST /render or GET /health'));

/* ---------- RENDER ---------- */
app.post('/render', async (req, res) => {
  let browser;
  try {
    const html = htmlFromPayload(req.body || {});
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      executablePath,
      headless: chromium.headless,
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 900, height: 1600, deviceScaleFactor: 2 },
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.scrollTo(0, 0));

    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false,
    });

    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    console.error('RENDER ERROR:', e);
    try { if (browser) await browser.close(); } catch (_) {}
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 LAMP renderer running on port ${PORT}`));
