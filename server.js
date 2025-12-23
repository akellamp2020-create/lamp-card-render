const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '2mb' }));

/** CORS */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
          cls: String(v?.cls ?? 'zero'),
        })),
        times: times.map(t => ({ text: String(t?.text ?? '') })),
      };
    }),
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------------- HTML ---------------- */

function htmlFromPayload(p) {
  const blocks = p?.blocks || {};
  const result = blocks?.result || null;

  const rozmin = normalizeTableBlock(blocks?.rozmin);
  const rozrah = normalizeTableBlock(blocks?.rozrahunok);

  const gameDate = String(p?.gameDate || '').trim();
  const resultTitle = gameDate ? `Результат гри від ${gameDate}` : 'Результат гри';

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
      overflow:hidden;
    }
    .title{ font-size:34px; font-weight:800; margin:0 0 14px 0; }
    .row{
      display:flex; justify-content:space-between; gap:16px;
      padding:18px 0; border-top:1px solid #f1f1f1; align-items:center;
    }
    .row:first-of-type{ border-top:0; padding-top:6px; }
    .k{ font-size:26px; color:#444; }
    .v{ font-size:34px; font-weight:800; } /* в Result */
    .pos{ color:#0a7a2f; }
    .neg{ color:#b00020; }
    .zero{ color:#111; }

    table.tbl{ width:100%; border-collapse:collapse; margin-top:12px; table-layout:auto; }
    td{
      padding:18px 10px; border-top:1px solid #f1f1f1;
      text-align:left; white-space:nowrap;
      font-size:34px; font-weight:400; /* ✅ числа в таблицах НЕ жирные */
    }
    .time td{
      font-weight:600; font-size:22px; color:#9a9a9a;
      padding-top:12px; padding-bottom:6px;
    }

    /* короткий последний чанк не тянется и остается слева */
    table.tbl.partial{
      width:auto;
      display:inline-table;
    }
  `;

  function renderResultCard() {
    if (!result) return '';
    const name = esc(result.name ?? '');
    const rows = Array.isArray(result.rows) ? result.rows : [];

    return `
      <div class="card">
        <div class="title">${esc(resultTitle)}</div>
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

  /**
   * ✅ Розмін/Розрахунок:
   * - "Разом" (values[0]) НЕ рисуем вообще
   * - по 5 чисел в строке
   */
  function renderTableCard(block) {
    if (!block || !Array.isArray(block.rows) || block.rows.length === 0) return '';

    const title = esc(block.title || '');
    const COLS_PER_ROW = 5;

    const rowsHtml = block.rows.map(r => {
      const valuesAll = Array.isArray(r?.values) ? r.values : [];
      const timesAll  = Array.isArray(r?.times)  ? r.times  : [];

      // ⛔ убрали "Разом"
      const restV = valuesAll.slice(1);
      const restT = timesAll.slice(1);
      if (!restV.length) return '';

      const vChunks = chunk(restV, COLS_PER_ROW);
      const tChunks = chunk(restT, COLS_PER_ROW);
      const hasTimes = restT.some(t => String(t?.text ?? '').trim() !== '');

      return vChunks.map((vc, idx) => {
        const tc = tChunks[idx] || [];
        const cols = Math.max(1, vc.length);
        const isPartial = cols < COLS_PER_ROW;

        const valuesRow = `<tr>${
          Array.from({ length: cols }, (_, i) => {
            const c = vc[i] || {};
            const cls = String(c?.cls || 'zero');
            return `<td class="${cls}">${esc(c?.text ?? '')}</td>`;
          }).join('')
        }</tr>`;

        const timesRow = (hasTimes && tc.length)
          ? `<tr class="time">${
              Array.from({ length: cols }, (_, i) => `<td>${esc(tc[i]?.text ?? '')}</td>`).join('')
            }</tr>`
          : '';

        return `
          <table class="tbl${isPartial ? ' partial' : ''}">
            <tbody>${valuesRow}${timesRow}</tbody>
          </table>
        `;
      }).join('');
    }).join('');

    return `
      <div class="card">
        <div class="title">${title}</div>
        ${rowsHtml}
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
app.get('/', (req, res) => res.type('text').send('LAMP renderer OK ✅\\nUse POST /render or GET /health'));

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
