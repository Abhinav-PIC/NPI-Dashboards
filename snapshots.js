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

// Project name mapping from short names to full names
const PROJECT_NAMES = {
  vm13: 'VM 13.0',
  blaze: 'Blaze 1.0',
  vm14: 'VM 14.0'
};

// Dashboard URLs for each project
const DASHBOARDS = {
  vm13: [
    "https://app.smartsheet.eu/b/publish?EQBCT=3b520afbf1da4f90a727c17fe95907f8",
    "https://app.smartsheet.eu/b/publish?EQBCT=01347ff55a724070a834146d3d87a0f6",
    "https://app.smartsheet.eu/b/publish?EQBCT=fef1863840294332a6b492bb15e9449d",
    "https://app.smartsheet.eu/b/publish?EQBCT=6d451758e57f4b5d960c35f1b4699c6b",
    "https://app.smartsheet.eu/b/publish?EQBCT=4af1d8a89b7d48a7ae3a28115bda420e"
  ],
  blaze: [
    "https://app.smartsheet.eu/b/publish?EQBCT=b22923d86abe45e99b9ed2abea242eec",
    "https://app.smartsheet.eu/b/publish?EQBCT=4de851d39dc848c8b319e5678b8c9c0a",
    "https://app.smartsheet.eu/b/publish?EQBCT=f774be235fb04630b40f3f344b32b40a",
    "https://app.smartsheet.eu/b/publish?EQBCT=b3905dbea4f649c197da14c84b3bc34c"
  ],
  vm14: [
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

function nowIsoTs(){
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  const YYYY = d.getUTCFullYear();
  const MM = pad(d.getUTCMonth()+1);
  const DD = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${YYYY}${MM}${DD}_${hh}${mm}${ss}Z`;
}

async function ensureDir(dir){
  try{ await fs.mkdir(dir, { recursive: true }); }catch(e){ /* ignore */ }
}

async function saveBuffer(filePath, buf){
  await fs.writeFile(filePath, buf);
}

async function scrollThroughEntirePage(page) {
  console.log("   📜 Pre-scrolling through entire page to load all content...");
  
  // First, scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  // Get initial page dimensions
  let prevScrollHeight = 0;
  let currentScrollHeight = await page.evaluate(() => document.body.scrollHeight);
  let scrollY = 0;
  let noChangeCount = 0;
  
  // Scroll through the entire page to trigger lazy loading
  while (scrollY < currentScrollHeight && noChangeCount < 5) {
    scrollY += SCROLL_STEP;
    await page.evaluate(y => window.scrollTo(0, y), scrollY);
    await sleep(GENTLE_SCROLL_PAUSE);
    
    // Check if page height has changed (new content loaded)
    prevScrollHeight = currentScrollHeight;
    currentScrollHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentScrollHeight === prevScrollHeight) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
      console.log(`   📈 Page height increased to ${currentScrollHeight}px`);
    }
    
    // Update scroll target if page grew
    if (scrollY >= currentScrollHeight) {
      break;
    }
  }

  // Scroll to the very bottom and wait a bit more
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000);

  // Final check for any last-minute content loading
  const finalHeight = await page.evaluate(() => document.body.scrollHeight);
  console.log(`   ✅ Finished pre-scrolling. Final page height: ${finalHeight}px`);

  // Scroll back to top before capturing
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  
  return finalHeight;
}

async function waitForStableContent(page) {
  console.log("   ⏳ Waiting for content to stabilize...");
  
  let stableCount = 0;
  let previousHeight = 0;
  
  // Wait for content to stop changing
  while (stableCount < 3) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === previousHeight) {
      stableCount++;
    } else {
      stableCount = 0;
      console.log(`   📏 Content height changed: ${currentHeight}px`);
    }
    
    previousHeight = currentHeight;
    await sleep(1000);
  }
  
  console.log("   ✅ Content appears stable");
}

async function capturePageFullStitched(page, outPathBase){
  // First, scroll through entire page to load all lazy content
  await scrollThroughEntirePage(page);
  
  // Wait for any final content to stabilize
  await waitForStableContent(page);
  
  // Now evaluate final page size (CSS pixels)
  const dims = await page.evaluate(() => {
    const body = document.body;
    const doc = document.documentElement;
    return {
      scrollWidth: Math.max(body.scrollWidth, doc.scrollWidth, doc.clientWidth),
      scrollHeight: Math.max(body.scrollHeight, doc.scrollHeight, doc.clientHeight),
      viewportWidth: Math.max(doc.clientWidth, window.innerWidth || 0),
      devicePixelRatio: window.devicePixelRatio || 1
    };
  });

  const cssWidth  = Math.ceil(dims.scrollWidth);
  const cssHeight = Math.ceil(dims.scrollHeight);
  const dpr = dims.devicePixelRatio;
  const sliceH = Math.min(SLICE_MAX_HEIGHT, cssHeight);

  console.log(`   📐 Final page dimensions: ${cssWidth} x ${cssHeight} CSS pixels`);

  // If page fits in one shot (small), just take fullPage screenshot (simpler)
  if (cssHeight <= page.viewport().height) {
    const buf = await page.screenshot({ fullPage: false, omitBackground: false, type: "png" });
    await saveBuffer(outPathBase + ".png", buf);
    return outPathBase + ".png";
  }

  // Create slices by scrolling & screenshotting clipped areas
  console.log(`   🔪 Creating ${Math.ceil(cssHeight / sliceH)} slices...`);
  const sliceFiles = [];
  let offsetY = 0;
  let sliceIndex = 0;

  while (offsetY < cssHeight) {
    const thisSliceHeight = Math.min(sliceH, cssHeight - offsetY);

    // Scroll to offset (CSS pixels)
    await page.evaluate(y => window.scrollTo(0, y), offsetY);
    await sleep(GENTLE_SCROLL_PAUSE);

    // Additional wait for any elements that might still be loading
    await sleep(200);

    // Compute clip in CSS pixels
    const clip = { x: 0, y: offsetY, width: cssWidth, height: thisSliceHeight };

    // Capture the slice
    const buf = await page.screenshot({ clip, omitBackground: false, type: "png" });

    const sliceFile = `${outPathBase}.slice-${sliceIndex}.png`;
    await saveBuffer(sliceFile, buf);
    sliceFiles.push(sliceFile);

    console.log(`   📷 Captured slice ${sliceIndex + 1} (y: ${offsetY}-${offsetY + thisSliceHeight})`);

    offsetY += thisSliceHeight;
    sliceIndex++;
  }

  // Stitch slices with sharp
  console.log("   🧩 Stitching slices together...");
  
  // Read first slice to get pixel width
  const firstMeta = await sharp(sliceFiles[0]).metadata();
  const pxWidth = firstMeta.width;
  const pxHeights = [];
  for (const file of sliceFiles){
    const m = await sharp(file).metadata();
    pxHeights.push(m.height);
  }
  const totalPxHeight = pxHeights.reduce((s,h)=>s+h, 0);

  const compositor = sharp({
    create: { width: pxWidth, height: totalPxHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  });

  // Build composite inputs
  let top = 0;
  const composites = [];
  for (const file of sliceFiles){
    const inputBuf = await fs.readFile(file);
    composites.push({ input: inputBuf, top, left: 0 });
    const meta = await sharp(inputBuf).metadata();
    top += meta.height;
  }

  // produce final image
  const finalBuf = await compositor.composite(composites).png({ quality: 100, compressionLevel: 0 }).toBuffer();
  const finalPath = outPathBase + ".png";
  await saveBuffer(finalPath, finalBuf);

  // cleanup slice files
  for (const f of sliceFiles){
    try{ await fs.unlink(f); }catch(e){ /* ignore */ }
  }

  console.log(`   ✅ Final image: ${pxWidth} x ${totalPxHeight} pixels`);
  return finalPath;
}

async function run(){
  // Get project and optional start index from command line arguments
  const targetProject = process.argv[2];
  const startFromDashboard = parseInt(process.argv[3]) || 1;
  
  if (!targetProject) {
    console.log("Usage: node snapshots.js <project> [startFromDashboard]");
    console.log(`Available projects: ${Object.keys(PROJECT_NAMES).join(', ')}`);
    console.log(`Project mapping: ${JSON.stringify(PROJECT_NAMES, null, 2)}`);
    console.log("Example: node snapshots.js vm14 5  (starts from Dashboard-5)");
    process.exit(1);
  }

  console.log('Project configuration:');
  console.log('- Available projects:', Object.keys(PROJECT_NAMES));
  console.log('- Project mappings:', PROJECT_NAMES);
  console.log('- Received project:', targetProject);
  console.log('- Maps to full name:', PROJECT_NAMES[targetProject]);
  
  if (!DASHBOARDS[targetProject]) {
    console.error(`Error: Unknown project '${targetProject}'. Available projects: ${Object.keys(PROJECT_NAMES).join(', ')}`);
    console.error('Valid project mappings:', JSON.stringify(PROJECT_NAMES, null, 2));
    process.exit(1);
  }

  console.log(`📸 Starting snapshots for project: ${targetProject}`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2,'0');
  const baseOutDir = path.join(OUT_ROOT, `${y}-${m}`);
  await ensureDir(baseOutDir);

  // Get the full project name from the short name
  const fullProjectName = PROJECT_NAMES[targetProject];
  if (!fullProjectName) {
    console.error(`Error: Unknown project '${targetProject}'. Available projects: ${Object.keys(PROJECT_NAMES).join(', ')}`);
    console.error('Valid project mappings:', JSON.stringify(PROJECT_NAMES, null, 2));
    process.exit(1);
  }

  // Create project-specific directory path
  const projectDir = path.join(baseOutDir, fullProjectName);
  await ensureDir(projectDir);

  const page = await browser.newPage();
  await page.setViewport(DEVICE_VIEWPORT);

  // Increase navigation timeout
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // Only process the specified project
  const project = targetProject;
  const urls = DASHBOARDS[project];
  console.log(`Starting from Dashboard-${startFromDashboard}`);
  
  for (let i = startFromDashboard - 1; i < urls.length; i++){
      const url = urls[i];
      const name = `${project}-${i+1}`;
      console.log(`➡ Capturing ${name} -> ${url}`);

      try {
        // navigate
        await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(e=>{ console.warn("→ nav warning:", e.message); });

        // Wait fixed time for Smartsheet to finish loading and settle
        console.log(`   waiting fixed ${WAIT_AFTER_LOAD_MS/1000}s for Smartsheet to render...`);
        await sleep(WAIT_AFTER_LOAD_MS);

        // Gentle extra wait for any animations / rendering
        await sleep(1500);

        // Try to detect and wait for Smartsheet-specific loading indicators
        await page.evaluate(async () => {
          // Wait for Smartsheet specific elements to be ready
          let attempts = 0;
          while (attempts < 30) {
            // Check for common Smartsheet loading indicators
            const loadingElements = document.querySelectorAll([
              '.loading',
              '.spinner', 
              '.smartsheet-loading',
              '[data-loading="true"]',
              '.app-loading'
            ].join(','));
            
            if (loadingElements.length === 0) break;
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
          }
        });

        // Additional wait for content to render
        await sleep(2000);

        // Evaluate if Smartsheet still shows a blue loading screen element we can detect - try removing it before capture.
        try {
          await page.evaluate(() => {
            // attempt to hide common Smartsheet loading overlays to avoid capturing them.
            const selectors = [
              ".app-loading-screen-2025",
              ".remove-app-loading-screen-2025",
              ".app-loading-screen",
              ".smartsheet-loading",
              ".loading-overlay",
              ".loading-spinner"
            ];
            for (const s of selectors){
              const el = document.querySelector(s);
              if (el) { el.style.display = "none"; }
            }
          });
        } catch(e){ /* ignore */ }

        // Scroll to top before measuring
        await page.evaluate(()=>window.scrollTo(0,0));
        await sleep(250);

        // set filename base with project-specific directory
        const fullProjectName = PROJECT_NAMES[project];
        const projectDir = path.join(baseOutDir, fullProjectName);
        const dashboardNumber = i + 1;
        const base = path.join(projectDir, `Dashboard-${dashboardNumber}`);
        const finalPath = await capturePageFullStitched(page, base);

        console.log(`✅ Saved: ${finalPath}`);
      } catch (err) {
        console.error(`❌ Error capturing ${name}:`, err && err.message ? err.message : err);
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