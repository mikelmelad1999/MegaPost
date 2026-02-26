import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import puppeteer from "npm:puppeteer-core";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
}

const BLOCKED_RESOURCES = ['font', 'media', 'other', 'manifest'];
const BLOCKED_DOMAINS = [
  'amazon-adsystem.com', 'google-analytics.com', 'facebook.net',
  'doubleclick.net', 'advertising-api-eu.amazon.com'
];

async function generateProductCardImage(productUrl: string, browserlessKey: string, showHighlights: boolean) {
  let browser;
  try {
    console.time("⏱️ Total Browser Logic");

    const endpoint = `wss://chrome.browserless.io?token=${browserlessKey}&--lang=ar-EG&--disable-notifications&--disable-extensions`;

    console.time("⏱️ Browser Connect");
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      defaultViewport: { width: 1280, height: 1600, deviceScaleFactor: 2 }
    });
    console.timeEnd("⏱️ Browser Connect");

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar-EG,ar;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (BLOCKED_RESOURCES.includes(req.resourceType()) || BLOCKED_DOMAINS.some(d => url.includes(d))) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.time("⏱️ Page Goto");
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.timeEnd("⏱️ Page Goto");

    console.time("⏱️ DOM Evaluation");
    const clipRegion = await page.evaluate((showHighlights) => {
      const toHide = [
        '#nav-belt', '#nav-main', '#navFooter', '.nav-footer',
        '#wayfinding-breadcrumbs_feature_div', '.s-breadcrumb',
        '[id*="CardInstance"]', '#abbWrapper', '#newerVersion_feature_div',
        '#addToWishlist_feature_div', '#wishlistButtonStack', '#adLink',
        '#inline-twister-row-size_name', '#variation_size_name', '#nav-extra-special-messaging'
      ];

      toHide.forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          if (el instanceof HTMLElement) el.style.setProperty('display', 'none', 'important');
        });
      });

      if (showHighlights) {
        const style = document.createElement('style');
        style.innerHTML = `
          .glow-box {
            position: absolute;
            border: 3px solid #00f2ff;
            border-radius: 8px;
            box-shadow: 0 0 15px rgba(0, 242, 255, 0.8);
            z-index: 99999;
            pointer-events: none;
          }
        `;
        document.head.appendChild(style);

        const draw = (sel) => {
          const el = document.querySelector(sel);
          if (el && el.getBoundingClientRect().width > 0) {
            const r = el.getBoundingClientRect();
            const box = document.createElement('div');
            box.className = 'glow-box';
            box.style.top = (r.top + window.scrollY - 8) + 'px';
            box.style.left = (r.left + window.scrollX - 8) + 'px';
            box.style.width = (r.width + 16) + 'px';
            box.style.height = (r.height + 16) + 'px';
            document.body.appendChild(box);
          }
        };

        draw('#corePriceDisplay_desktop_feature_div');
        draw('#corePrice_desktop');
        draw('#availability');
      }

      const ppd = document.getElementById('ppd');
      if (!ppd) return null;

      const leftCol = document.getElementById('leftCol');
      const imageCanvas = document.getElementById('imgTagWrapperId') || document.getElementById('main-image-container');
      const sellerInfo = document.querySelector('.offer-display-features-container') || document.getElementById('merchantInfoFeature_feature_div');

      const ppdRect = ppd.getBoundingClientRect();
      const endpoints = [];

      if (leftCol) endpoints.push(leftCol.getBoundingClientRect().bottom);
      if (imageCanvas) endpoints.push(imageCanvas.getBoundingClientRect().bottom);
      if (sellerInfo) endpoints.push(sellerInfo.getBoundingClientRect().bottom);

      const maxBottom = Math.max(...endpoints, ppdRect.top + 550);

      return {
        x: Math.max(0, ppdRect.x - 5),
        y: Math.max(0, ppdRect.y - 5),
        width: ppdRect.width + 10,
        height: (maxBottom - ppdRect.top) + 25
      };
    }, showHighlights);
    console.timeEnd("⏱️ DOM Evaluation");

    if (!clipRegion) throw new Error("Could not find product details container (#ppd)");
    await new Promise(r => setTimeout(r, 500));

    console.time("⏱️ Screenshot Taking");
    const imageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90,
      clip: clipRegion
    });

    console.timeEnd("⏱️ Screenshot Taking");
    console.timeEnd("⏱️ Total Browser Logic");
    return imageBuffer;

  } finally {
    if (browser) await browser.close();
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { asin, url, showHighlights = true } = await req.json();
    const deviceId = req.headers.get('x-device-id');
    const productUrl = url || `https://www.amazon.eg/dp/${asin}`;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: user } = await supabase.from('user_settings').select('browserless_key').eq('device_id', deviceId).single();

    const buffer = await generateProductCardImage(productUrl, user?.browserless_key || "", showHighlights);

    const fileName = `radar_onebox_${asin}_${Date.now()}.jpg`;
    await supabase.storage.from('banners').upload(fileName, buffer, { contentType: 'image/jpeg' });
    const { data: { publicUrl } } = supabase.storage.from('banners').getPublicUrl(fileName);

    return new Response(JSON.stringify({ screenshot_url: publicUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: corsHeaders, status: 400 });
  }
});