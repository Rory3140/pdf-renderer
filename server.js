const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const GCS_BUCKET = process.env.GCS_BUCKET || 'plugpv-pdf-renderer';

function getStorageClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const decoded = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const credentials = JSON.parse(decoded);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  const keyFile = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(keyFile)) {
    return new Storage({ keyFilename: keyFile });
  }
  throw new Error('No GCS credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON or add service-account.json');
}

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/pdf', async (req, res) => {
  const {
    api_key,
    url,
    format = 'A4',
    landscape = false,
    wait_until = 'networkidle0',
    wait_for_selector,
    wait_ms = 0,
    scale = 1,
    print_background = true,
    margin,
    capture_element,
    upload_to_gcs = false,
  } = req.body;

  if (!api_key || api_key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing api_key' });
  }

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  let browser;
  const timeout = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
    if (!res.headersSent) {
      res.status(504).json({ error: 'PDF generation timed out' });
    }
  }, 60000);

  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: wait_until });

    if (wait_for_selector) {
      await page.waitForSelector(wait_for_selector, { timeout: 15000 });
    }

    if (wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait_ms));
    }

    let captureWidth = null;

    let captureHeight = null;
    if (capture_element) {
      ({ captureWidth, captureHeight } = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`capture_element "${selector}" not found`);

        // Snapshot every descendant's current computed pixel height BEFORE expanding
        // the container, so height:100% children don't stretch when the parent grows.
        const scrollH = el.scrollHeight;
        el.querySelectorAll('*').forEach(child => {
          const h = child.getBoundingClientRect().height;
          if (h > 0) child.style.setProperty('height', h + 'px', 'important');
          child.style.setProperty('overflow', 'visible', 'important');
        });

        // Expand the container to its full scroll height so all content is in view.
        el.style.setProperty('height', scrollH + 'px', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('margin-top', '0px', 'important');
        el.style.setProperty('padding-top', '0px', 'important');
        // Also strip top margin/padding from the first child (hero element)
        if (el.firstElementChild) {
          el.firstElementChild.style.setProperty('margin-top', '0px', 'important');
          el.firstElementChild.style.setProperty('padding-top', '0px', 'important');
        }

        // Expand ancestors so the body layout height matches the full content.
        let ancestor = el.parentElement;
        while (ancestor && ancestor !== document.body) {
          ancestor.style.setProperty('overflow', 'visible', 'important');
          ancestor.style.setProperty('height', 'auto', 'important');
          ancestor.style.setProperty('min-height', scrollH + 'px', 'important');
          ancestor = ancestor.parentElement;
        }
        document.body.style.setProperty('overflow', 'visible', 'important');
        document.body.style.setProperty('min-height', scrollH + 'px', 'important');

        // Mark body-level ancestor so overlays can be hidden via @media print CSS
        let direct = el;
        while (direct.parentElement !== document.body) {
          direct = direct.parentElement;
        }
        direct.setAttribute('data-pdf-keep', 'true');

        // Add a small buffer so content that renders slightly taller than scrollHeight
        // (e.g. canvas elements like signatures) doesn't spill onto a second page.
        return { captureWidth: el.scrollWidth, captureHeight: scrollH + 100 };
      }, capture_element));

      await page.addStyleTag({
        content: `
          @media print {
            body > *:not([data-pdf-keep]) { display: none !important; }
            html, body { margin: 0 !important; padding: 0 !important; }
            [data-pdf-keep] { margin-top: 0 !important; padding-top: 0 !important; position: static !important; top: 0 !important; }
          }
        `,
      });
    }

    const pdfOptions = {
      printBackground: print_background,
      scale,
      margin: margin || { top: '0px', bottom: '0px', left: '0px', right: '0px' },
    };

    if (margin) pdfOptions.margin = margin;

    if (captureWidth && captureHeight) {
      // Single-page PDF sized exactly to the captured element — no page breaks.
      pdfOptions.width = captureWidth + 'px';
      pdfOptions.height = captureHeight + 'px';
    } else {
      pdfOptions.format = format;
      pdfOptions.landscape = landscape;
    }

    const pdfBuffer = Buffer.from(await page.pdf(pdfOptions));

    clearTimeout(timeout);

    if (upload_to_gcs) {
      const storage = getStorageClient();
      const fileName = `pdf-renderer/${Date.now()}.pdf`;
      const file = storage.bucket(GCS_BUCKET).file(fileName);
      await file.save(pdfBuffer, { contentType: 'application/pdf' });
      const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${fileName}`;
      return res.status(200).json({ url: publicUrl });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');
    res.status(200).send(pdfBuffer);
  } catch (err) {
    clearTimeout(timeout);
    console.error('PDF generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'PDF generation failed' });
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`pdf-renderer listening on port ${PORT}`);
});
