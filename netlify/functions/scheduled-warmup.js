import { schedule } from "@netlify/functions";

// ฟังก์ชันนี้จะถูกเรียกโดย Netlify Scheduler ตามเวลาที่ตั้งไว้
const handler = schedule("0 */6 * * *", async (event) => {
  const SITE_URL = process.env.URL || "http://localhost:8888";
  
  // แคชชุดชาร์ตหลักที่ผู้ใช้ส่วนใหญ่ใช้งาน
  const targets = [
    `${SITE_URL}/api/catalog?cc=th,us&limit=100`,
    `${SITE_URL}/api/catalog?cc=th&limit=50`
  ];

  console.log(`[Warmup] Starting catalog hydration at ${new Date().toISOString()}`);

  const results = await Promise.all(
    targets.map(url => 
      fetch(url)
        .then(res => res.json())
        .then(d => ({ url, ok: d.ok, count: d.count }))
        .catch(err => ({ url, error: err.message }))
    )
  );

  console.log("[Warmup] Results:", JSON.stringify(results));
  
  return { statusCode: 200 };
});

export { handler };
