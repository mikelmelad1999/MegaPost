import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7?bundle";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8"
};

function getArabicTime() {
  const now = new Date();
  const options = { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true };
  return now.toLocaleTimeString('en-US', options as any).replace('AM', 'ص').replace('PM', 'م');
}

async function notifyAdmin(config: any, payload: any) {
  if (!config.tg_admin_id || !config.tg_bot_token) return;
  const baseUrl = `https://api.telegram.org/bot${config.tg_bot_token}`;

  const text = `
🔔 <b>تحديث تلقائي للمنتج</b>

📌 <b>الاسم:</b> ${payload.title || 'بدون عنوان'}
🆔 <b>ASIN:</b> <code>${payload.asin}</code>

💰 <b>السعر:</b> ${Math.floor(payload.oldPrice || 0)} ← <b>${Math.floor(payload.newPrice || 0)} ج.م</b>
✅ <b>الحالة:</b> ${payload.status}

🔗 <b>رابط المنتج:</b>
${payload.link}

🕒 ${getArabicTime()}
`.trim();

  try {
    await fetch(`${baseUrl}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.tg_admin_id,
        photo: payload.image,
        caption: text.substring(0, 1024),
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Admin Notify Error:", e);
  }
}

async function sha256(message: string) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return new Uint8Array(hashBuffer);
}
async function hmac(key: string | Uint8Array, message: string) {
  const keyBuffer = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}
function toHex(array: Uint8Array) {
  return Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getSignatureKey(key: string, dateStamp: string, region: string, service: string) {
  const kDate = await hmac("AWS4" + key, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function getAmazonItemsBatch(asins: string[], config: any) {
  const HOST = "webservices.amazon.eg";
  const REGION = "eu-west-1";
  const PATH = "/paapi5/getitems";
  const payload = JSON.stringify({
    "ItemIds": asins,
    "PartnerTag": config.amazon_partner_tag.trim(),
    "PartnerType": "Associates",
    "Marketplace": "www.amazon.eg",
    "Resources": ["Images.Primary.HighRes", "ItemInfo.Title", "OffersV2.Listings.Price"]
  });

  const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    "host": HOST,
    "x-amz-date": amzDate,
    "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join("");
  const payloadHash = toHex(await sha256(payload));
  const canonicalRequest = `POST\n${PATH}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${REGION}/ProductAdvertisingAPI/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${toHex(await sha256(canonicalRequest))}`;
  const signingKey = await getSignatureKey(config.amazon_secret_key.trim(), dateStamp, REGION, "ProductAdvertisingAPI");
  const signature = toHex(await hmac(signingKey, stringToSign));

  headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${config.amazon_access_key.trim()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${HOST}${PATH}`, { method: "POST", headers, body: payload });
  return await res.json();
}

async function startAutoUpdate() {
  const { data: allConfigs } = await supabase.from("user_settings").select("*");
  if (!allConfigs) return { status: "no_configs" };

  for (const config of allConfigs) {
    const { data: products } = await supabase.from("products")
      .select("*")
      .eq("user_id", config.device_id)
      .order("last_update", { ascending: true })
      .limit(20);

    if (!products || products.length === 0) continue;

    const currentBatchPrices = new Map();
    const amzData = await getAmazonItemsBatch(products.map(p => p.asin), config);
    const amzItems = amzData?.ItemsResult?.Items || [];

    amzItems.forEach((item: any) => {
      const price = item?.OffersV2?.Listings?.[0]?.Price?.Money?.Amount;
      if (price !== undefined && price !== null) currentBatchPrices.set(item.ASIN, price);
    });

    for (const p of products) {
      const newPrice = currentBatchPrices.get(p.asin);

      if (newPrice !== undefined && Math.floor(newPrice) !== Math.floor(p.price)) {
        await notifyAdmin(config, {
          title: p.title,
          asin: p.asin,
          image: p.image,
          link: p.affiliate_link,
          oldPrice: p.price,
          newPrice: newPrice,
          status: newPrice <= 0 ? "❌ نفد من المخزون" : "✅ تم تحديث السعر"
        });

        await supabase.from("products").update({
          price: newPrice,
          last_update: new Date().toISOString()
        }).eq("asin", p.asin).eq("user_id", config.device_id);
      } else {
        await supabase.from("products").update({
          last_update: new Date().toISOString()
        }).eq("asin", p.asin).eq("user_id", config.device_id);
      }
    }
  }
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const res = await startAutoUpdate();
    return new Response(JSON.stringify(res), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});