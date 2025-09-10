// snapshots.js
// Node 18+, package.json: { "type": "module" }
// npm i puppeteer sharp

import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";
import sharp from "sharp";

const OUT_ROOT = "snapshots";
const DEVICE_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 4 };
const WAIT_AFTER_LOAD_MS = 60000; // 60s wait for Smartsheet to render + settle
const SLICE_MAX_HEIGHT = 4000;     // CSS pixels per slice (increase if you want bigger single slices)
const GENTLE_SCROLL_PAUSE = 500;   // pause after each scroll (ms)
const NAV_TIMEOUT = 120000;        // navigation timeout (ms)
const SCROLL_STEP = 800;           // pixels to scroll in each step during full page scan

// Dashboard URLs for each project
const DASHBOARDS = {
  "VM 13.0": [
    "https://app.smartsheet.eu/b/publish?EQBCT=3b520afbf1da4f90a727c17fe95907f8",
    "https://app.smartsheet.eu/b/publish?EQBCT=01347ff55a724070a834146d3d87a0f6",
    "https://app.smartsheet.eu/b/publish?EQBCT=fef1863840294332a6b492bb15e9449d",
    "https://app.smartsheet.eu/b/publish?EQBCT=6d451758e57f4b5d960c35f1b4699c6b",
    "https://app.smartsheet.eu/b/publish?EQBCT=4af1d8a89b7d48a7ae3a28115bda420e"
  ],
  "Blaze 1.0": [
    "https://app.smartsheet.eu/b/publish?EQBCT=b22923d86abe45e99b9ed2abea242eec",
    "https://app.smartsheet.eu/b/publish?EQBCT=4de851d39dc848c8b319e5678b8c9c0a",
    "https://app.smartsheet.eu/b/publish?EQBCT=f774be235fb04630b40f3f344b32b40a",
    "https://app.smartsheet.eu/b/publish?EQBCT=b3905dbea4f649c197da14c84b3bc34c"
  ],
  "VM 14.0": [
    "https://app.smartsheet.eu/b/publish?EQBCT=a2759a020f6e45a3a6dc3fea089b2bd4",
    "https://app.smartsheet.eu/b/publish?EQBCT=28c0f9d1fa8541858e7054f76798a6d3",
    "https://app.smartsheet.eu/b/publish?EQBCT=6fca486dbfc842c7afac7cb0ced8337e",
    "https://app.smartsheet.eu/b/publish?EQBCT=9415a9327886401ba0d2885d3f8c9cc1",
    "https://app.smartsheet.eu/b/publish?EQBCT=ce6e7d063b1648d6858744777f5ea68c",
    "https://app.smartsheet.eu/b/publish?EQBCT=dbc388d3830a4e5c982d5fe412dfeeac",
    "https://app.smartsheet.eu/b/publish?EQBCT=627bfbe702fa4b97a5d110af100445c3"
  ]
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function ensureDir(dir){
  try{ await fs.mkdir(dir, { recursive: true }); }catch(e){ /* ignore */ }
}

async function preparePageForCapture(page) {
  console.log("   Pre-loading all content...");
  
  let prevHeight = 0;
  let currentHeight = await page.evaluate(() => document.body.scrollHeight);
  let scrollY = 0;
  let stableCount = 0;
  
  // Scroll through page to load all content
  while (scrollY < currentHeight && stableCount < 5) {
    await page.evaluate(y => window.scrollTo(0, y), scrollY);
    await sleep(GENTLE_SCROLL_PAUSE);
    
    scrollY += SCROLL_STEP;
    prevHeight = currentHeight;
    currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === prevHeight) {
      stableCount++;
    } else {
      stableCount = 0;
    }
  }
  
  await page.evaluate(() => window.scrollTo(0, 0));
  return currentHeight;
}

async function capturePageFullStitched(page, outPathBase) {
  // Load all content and get final dimensions
  await preparePageForCapture(page);
  
  const dims = await page.evaluate(() => ({
    width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
    height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  }));

  const cssWidth = Math.ceil(dims.width);
  const cssHeight = Math.ceil(dims.height);
  const sliceH = Math.min(SLICE_MAX_HEIGHT, cssHeight);

  // Take single screenshot if page is small enough
  if (cssHeight <= page.viewport().height) {
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    await fs.writeFile(outPathBase + ".png", buf);
    return outPathBase + ".png";
  }

  // Capture slices for larger pages
  const sliceFiles = [];
  let offsetY = 0;

  while (offsetY < cssHeight) {
    const thisSliceHeight = Math.min(sliceH, cssHeight - offsetY);
    await page.evaluate(y => window.scrollTo(0, y), offsetY);
    await sleep(GENTLE_SCROLL_PAUSE);

    const buf = await page.screenshot({
      clip: { x: 0, y: offsetY, width: cssWidth, height: thisSliceHeight },
      type: "png"
    });

    const sliceFile = `${outPathBase}.slice-${sliceFiles.length}.png`;
    await fs.writeFile(sliceFile, buf);
    sliceFiles.push(sliceFile);

    offsetY += thisSliceHeight;
  }

  // Stitch slices together
  const [firstSlice, ...otherSlices] = await Promise.all(
    sliceFiles.map(f => sharp(f).metadata())
  );
  
  const pxWidth = firstSlice.width;
  const totalPxHeight = firstSlice.height + otherSlices.reduce((sum, m) => sum + m.height, 0);

  const compositor = sharp({
    create: {
      width: pxWidth,
      height: totalPxHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  let top = 0;
  const composites = await Promise.all(sliceFiles.map(async file => {
    const buf = await fs.readFile(file);
    const pos = { input: buf, top, left: 0 };
    top += (await sharp(buf).metadata()).height;
    return pos;
  }));

  const finalPath = outPathBase + ".png";
  await compositor
    .composite(composites)
    .png({ quality: 100 })
    .toFile(finalPath);

  // Cleanup
  await Promise.all(sliceFiles.map(f => fs.unlink(f).catch(() => {})));
  
  return finalPath;
}

async function run() {
  const project = process.argv[2];
  const startFromDashboard = parseInt(process.argv[3]) || 1;
  
  if (!project || !DASHBOARDS[project]) {
    console.log("Usage: node snapshots.js <project> [startFromDashboard]");
    console.log("Available projects:");
    console.log(`  ${Object.keys(DASHBOARDS).join('\n  ')}`);
    console.log("\nExample: node snapshots.js 'VM 14.0' 5");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const outDir = path.join(
    OUT_ROOT,
    new Date().toISOString().slice(0, 7),
    project
  );
  await ensureDir(outDir);

  const page = await browser.newPage();
  await page.setViewport(DEVICE_VIEWPORT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const urls = DASHBOARDS[project];
  console.log(`Capturing dashboards for ${project} (${startFromDashboard}-${urls.length})`);
  
  for (let i = startFromDashboard - 1; i < urls.length; i++) {
    const dashboardNumber = i + 1;
    console.log(`\nDashboard ${dashboardNumber}/${urls.length}: ${urls[i]}`);
    
    try {
        const url = urls[i];
        // Navigate and wait for initial load
        await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
        
        // Wait for Smartsheet to load and stabilize
        console.log(`   Waiting ${WAIT_AFTER_LOAD_MS/1000}s for Smartsheet...`);
        await sleep(WAIT_AFTER_LOAD_MS);
        
        // Handle any remaining loading elements
        await page.evaluate(async () => {
          const loadingSelectors = [
            '.loading', '.spinner', '.smartsheet-loading', '[data-loading="true"]',
            '.app-loading', '.app-loading-screen-2025', '.remove-app-loading-screen-2025',
            '.app-loading-screen', '.loading-overlay', '.loading-spinner'
          ];
          
          // Wait for loaders to disappear
          for (let i = 0; i < 30; i++) {
            const loaders = document.querySelectorAll(loadingSelectors.join(','));
            if (loaders.length === 0) break;
            
            // Try to hide any remaining loaders
            loaders.forEach(el => el.style.display = 'none');
            await new Promise(r => setTimeout(r, 1000));
          }
        });
        
        await page.evaluate(() => window.scrollTo(0, 0));

        // set filename base with project-specific directory
        const dashboardNumber = i + 1;
        const base = path.join(outDir, `Dashboard-${dashboardNumber}`);
        const finalPath = await capturePageFullStitched(page, base);

        console.log(`✅ Saved: ${finalPath}`);
      } catch (err) {
        console.error(`❌ Error capturing dashboard ${dashboardNumber}:`, err && err.message ? err.message : err);
      }
    }

  await page.close();
  await browser.close();
  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});