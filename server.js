const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

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

    if (capture_element) {
      captureWidth = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`capture_element "${selector}" not found`);

        // Remove overflow clipping only — do NOT change heights (sections use height:100%
        // relative to container, so changing container height would stretch them).
        el.style.setProperty('overflow', 'visible', 'important');
        Array.from(el.children).forEach(child => {
          child.style.setProperty('overflow', 'visible', 'important');
        });

        // Mark body-level ancestor so overlays can be hidden via @media print CSS
        let direct = el;
        while (direct.parentElement !== document.body) {
          direct = direct.parentElement;
        }
        direct.setAttribute('data-pdf-keep', 'true');

        return el.scrollWidth;
      }, capture_element);

      await page.addStyleTag({
        content: `
          @media print {
            body > *:not([data-pdf-keep]) { display: none !important; }
            body { margin: 0 !important; padding: 0 !important; }
          }
        `,
      });
    }

    const pdfOptions = {
      printBackground: print_background,
      scale,
      margin: margin || { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    };

    if (margin) pdfOptions.margin = margin;

    if (captureWidth) {
      // Use the element's natural pixel width so content isn't squished, A4 height for pagination
      pdfOptions.width = captureWidth + 'px';
      pdfOptions.height = '11.69in';
    } else {
      pdfOptions.format = format;
      pdfOptions.landscape = landscape;
    }

    const pdfBuffer = Buffer.from(await page.pdf(pdfOptions));

    clearTimeout(timeout);
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
