// Browser test of the sync engine with real <video> elements.
// node tests/harness/run.mjs  (static server on :8765 serving the repo root; clips in tests/harness/media/, EXT=mp4 or webm)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || "playwright");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1040, height: 300 } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto("http://127.0.0.1:8765/tests/harness/index.html?ext=" + (process.env.EXT || "webm"));
await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.readyState >= 1));

let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`, extra ?? ""); if (!ok) failures++; };
const report = () => page.evaluate(() => api.report());

// 1. paused seek: every video lands on its frame
await page.evaluate(() => api.seek(api.D(20, 47, 25)));
await sleep(800);
let r = await report();
check("paused seek accuracy < 40 ms", r.every((x) => Math.abs(x.err) < 0.04 && x.paused), r);

// 2. play 5 s at x1: drift stays small
await page.evaluate(() => api.play());
await sleep(5000);
r = await report();
check("playing x1 for 5 s: |drift| < 100 ms", r.filter((x) => x.status === "sync").every((x) => Math.abs(x.err) < 0.1 && !x.paused), r);

// 3. clip T03 not started before 20:47:20 -> "before", paused at 0
await page.evaluate(() => api.seek(api.D(20, 47, 5)));
await sleep(1000);
r = await report();
const t3 = r.find((x) => x.uar === "GE0210-T03");
check("clip not yet started is held at 0 and flagged", t3.status === "before" && t3.paused && t3.currentTime < 0.05, t3);
const t1 = r.find((x) => x.uar === "GE0210-T01");
check("clip in range keeps playing after jump", t1.status === "sync" && !t1.paused && Math.abs(t1.err) < 0.15, t1);

// 4. rate x2 then measure drift
await page.evaluate(() => { api.seek(api.D(20, 47, 21)); api.rate(2); });
await sleep(3000);
r = await report();
check("playing x2: |drift| < 150 ms", r.filter((x) => x.status === "sync").every((x) => Math.abs(x.err) < 0.15), r);

// 5. user seeks one video with its native control -> master clock follows
await page.evaluate(() => { api.pause(); api.rate(1); });
await sleep(300);
await page.evaluate(() => { document.getElementById("GE0210-T02").currentTime = 3.0; });
await sleep(800);
const st = await page.evaluate(() => api.state);
const expected = Date.UTC(2025, 9, 2, 20, 47, 0) + 15.4 * 1000;
check("native seek on a clip moves the master clock", Math.abs(st.time - expected) < 50, { got: st.time - Date.UTC(2025, 9, 2, 20, 47, 0) });
r = await report();
check("...and the other clips follow", r.every((x) => x.status !== "sync" || Math.abs(x.err) < 0.04), r);

// 6. past the end of a clip
await page.evaluate(() => api.seek(api.D(20, 47, 50)));
await sleep(800);
r = await report();
check("clip finished is flagged 'after'", r.find((x) => x.uar === "GE0210-T02").status === "after", r);

// screenshot with all three clips in range
await page.evaluate(() => api.seek(api.D(20, 47, 22.25)));
await sleep(1000);
await page.screenshot({ path: process.env.SHOT || "harness.png" });
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
