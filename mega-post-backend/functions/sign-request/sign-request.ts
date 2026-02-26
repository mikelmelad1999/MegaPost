import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const headersBase = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-device-id",
};



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

async function getItemByASIN(asin: string, keys: any) {
  const HOST = "webservices.amazon.eg";
  const REGION = "eu-west-1";
  const PATH = "/paapi5/getitems";

  const realAccessKey = keys.accessKey.trim();
  const realSecretKey = keys.secretKey.trim();
  const realPartnerTag = keys.partnerTag.trim();

  const payload = JSON.stringify({
    "ItemIds": [asin],
    "PartnerTag": realPartnerTag,
    "PartnerType": "Associates",
    "Marketplace": "www.amazon.eg",
    "LanguagesOfPreference": ["ar_AE"],
    "Resources": [
      "Images.Primary.HighRes",
      "Images.Primary.Large",
      "Images.Variants.HighRes",
      "Images.Variants.Large",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "ItemInfo.Classifications",
      "ItemInfo.ByLineInfo",
      "OffersV2.Listings.Price",
      "Offers.Listings.SavingBasis",
      "CustomerReviews.Count",
      "CustomerReviews.StarRating"
    ]
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

  const signingKey = await getSignatureKey(realSecretKey, dateStamp, REGION, "ProductAdvertisingAPI");
  const signature = toHex(await hmac(signingKey, stringToSign));

  headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${realAccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${HOST}${PATH}`, { method: "POST", headers, body: payload });
  return await response.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: headersBase });

  try {
    const { asin, amazonKeys } = await req.json();
    
    if (!asin || !amazonKeys) {
      throw new Error("Missing Parameters (ASIN, Keys)");
    }

    const data = await getItemByASIN(asin, amazonKeys);
    console.log("Amazon API Response Data:", JSON.stringify(data, null, 2));
    return new Response(JSON.stringify(data), { 
      status: 200, 
      headers: headersBase 
    });

  } catch (e) {
    console.error("Function Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, 
      headers: headersBase 
    });
  }
});
