const fs = require('fs');
const https = require('https');
const path = require('path');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;
const THUMBNAIL_DIR = path.join(__dirname, 'patreon', 'posts');
const THUMBNAIL_WIDTH = 425;
const THUMBNAIL_HEIGHT = 221;

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;

// Normalize relative URLs
function normalizeURL(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `https://www.patreon.com${url}`;
}

function fetchPatreonPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Bearer ${PATREON_ACCESS_TOKEN}`,
        'User-Agent': 'Living-In-Viellci'
      }
    };
    https.get(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Patreon API returned ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

function extractFirstImageFromContent(content) {
  if (!content) return null;
  const matches = content.matchAll(/<img[^>]+src="([^">]+)"/g);
  for (const match of matches) {
    const url = match[1];
    if (url.match(/\.(png|jpg|jpeg)(\?|$)/i)) {
      return url;
    }
  }
  return null;
}

function findImageForPost(post) {
  const descImage = extractFirstImageFromContent(post.attributes.content);
  
  if (post.attributes.embed_data?.image) {
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;
    return embedImage;
  }

  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.(png|jpg|jpeg)/i)) {
    return post.attributes.embed_url;
  }

  return descImage;
}

async function screenshotAndResizeImage(imageUrl, postId, browser) {
  try {
    console.log(`   Screenshotting image: ${imageUrl}`);

    const page = await browser.newPage();

    // Set viewport to a reasonable size
    await page.setViewport({ width: 1920, height: 1080 });

    // Create a simple HTML page with just the image
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; background: #000; }
          img { max-width: 100%; max-height: 100vh; object-fit: contain; }
        </style>
      </head>
      <body>
        <img src="${imageUrl}" alt="Post thumbnail" />
      </body>
      </html>
    `;

    await page.setContent(html);

    // Wait for image to load
    await page.waitForSelector('img', { timeout: 10000 });
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const img = document.querySelector('img');
        if (img.complete) {
          resolve();
        } else {
          img.addEventListener('load', resolve);
          img.addEventListener('error', resolve);
        }
      });
    });

    // Take screenshot of the image element
    const imageElement = await page.$('img');
    const screenshotBuffer = await imageElement.screenshot({ type: 'png' });

    await page.close();

    // Resize image to 425x221 using sharp
    const resizedBuffer = await sharp(screenshotBuffer)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
        fit: 'cover',
        position: 'center'
      })
      .png()
      .toBuffer();

    // Save to file
    const filename = `${postId}.png`;
    const filepath = path.join(THUMBNAIL_DIR, filename);
    fs.writeFileSync(filepath, resizedBuffer);

    console.log(`   ✓ Saved thumbnail: ${filename}`);

    return `patreon/posts/${filename}`;

  } catch (error) {
    console.error(`   ✗ Failed to screenshot image: ${error.message}`);
    return null;
  }
}

function sanitizePostId(url) {
  // Extract post ID from URL like "/posts/weekly-log-11-144156455"
  const match = url.match(/(\d+)$/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, '-');
}

async function fetchPatreonMembers() {
  console.log(`\nFetching Patreon members`);
  let allMembers = [];
  let allIncluded = [];
  let nextUrl = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/members?include=user,currently_entitled_tiers&fields[member]=patron_status,full_name`;

  while (nextUrl) {
    const response = await fetchPatreonPage(nextUrl);
    if (!response) break;

    if (response.data) allMembers = allMembers.concat(response.data);
    if (response.included) allIncluded = allIncluded.concat(response.included);
    nextUrl = response.links?.next || null;
  }
  const includedTypes = {};
  allIncluded.forEach(item => includedTypes[item.type] = (includedTypes[item.type] || 0) + 1);
  console.log('DEBUG: included types and counts =', includedTypes);

  console.log('DEBUG: included sample first 10 =', allIncluded.slice(0, 10));
  
  console.log(`Found ${allMembers.length} total member entries`);
  return { allMembers, allIncluded };
}

function processMembers(rawMembers, rawIncluded) {
  console.log(`\nProcessing members...`);

  // Load existing members to preserve history & notes
  let existing = [];
  if (fs.existsSync("patreon-members.json")) {
    try {
      const fileData = fs.readFileSync("patreon-members.json", "utf8");
      if (fileData.trim()) {
        existing = JSON.parse(fileData).members || [];
      }
    } catch (err) {
      console.warn("Could not parse patreon-members.json, starting fresh.");
    }
  }

  const existingMap = {};
  existing.forEach(m => existingMap[m.name] = m);

  const tierLookup = {};
  rawIncluded
    .filter(item => item.type === "tier")
    .forEach(tier => {
      const title = tier.attributes && (tier.attributes.title || tier.attributes.name || tier.attributes.description) || null;
      if (title) tierLookup[tier.id] = title;
      else tierLookup[tier.id] = null;
    });
  console.log('DEBUG: tierLookup built =', tierLookup);

  const FORMER_TIER_ID = "10450352";

  // Build final list
  const finalMembers = rawMembers.map(member => {
    const name = member.attributes.full_name || "Unknown";
    const rawTierIds = member.relationships?.currently_entitled_tiers?.data.map(t => t.id) || [];
    const paidTierIds = rawTierIds.filter(id => id !== FORMER_TIER_ID);

    if (paidTierIds.length === 0) {
      const previous = existingMap[name];

      const previousHasPaid = previous && Array.isArray(previous.pledge_levels) && previous.pledge_levels.some(p => p && p !== FORMER_TIER_ID);

      if (!previousHasPaid) {
        return null;
      }

      console.log(`DEBUG: keeping ${name} from existing file - was former paid`);
      return {
        name,
        pledge_levels: previous.pledge_levels,
        is_active: member.attributes.patron_status === "active_patron",
        additional_note: previous.additional_note || ""
      };
    }

    // At least one paid tier present — convert IDs to names
    const tierNames = paidTierIds.map(id => {
      const resolved = tierLookup[id];
      if (!resolved) {
        console.warn(`DEBUG: tier id ${id} has no resolved name in included data.`);
      }
      return resolved;
    }).filter(Boolean);

    // Merge pledge history with previous
    const previous = existingMap[name];
    const mergedLevels = previous
      ? Array.from(new Set([...(previous.pledge_levels || []), ...tierNames]))
      : tierNames;

    return {
      name,
      pledge_levels: mergedLevels,
      is_active: member.attributes.patron_status === "active_patron",
      additional_note: previous?.additional_note || ""
    };
  }).filter(Boolean); // remove nulls

  console.log(`DEBUG: finalMembers count = ${finalMembers.length}`);
  return finalMembers;
}

async function main() {
  let browser = null;

  try {
    console.log('Fetching all Patreon posts...');

    // Properly encode query parameters
    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'page[count]': '100'
    });

    let allPosts = [];
    let nextUrl = `${API_URL}?${query.toString()}`;
    let pageCount = 0;

    while (nextUrl) {
      pageCount++;
      console.log(`Fetching page ${pageCount}: ${nextUrl}`);
      const response = await fetchPatreonPage(nextUrl);

      if (!response.data || response.data.length === 0) {
        console.log(`Page ${pageCount} has no posts.`);
        break;
      }

      allPosts = allPosts.concat(response.data);
      console.log(`Fetched ${response.data.length} posts from page ${pageCount} (total so far: ${allPosts.length})`);

      nextUrl = response.links && response.links.next ? response.links.next : null;
    }

    if (allPosts.length === 0) {
      console.log('No posts found across all pages.');
      process.exit(0);
    }

    console.log(`Total fetched posts across ${pageCount} pages: ${allPosts.length}`);

    // Filter public posts
    const publicPosts = allPosts.filter(post => post.attributes.is_public);

    // Manually sort by published date, newest first
    publicPosts.sort((a, b) => {
      const dateA = new Date(a.attributes.published_at);
      const dateB = new Date(b.attributes.published_at);
      return dateB.getTime() - dateA.getTime();
    });

    // Take only the top 10 newest public posts
    const topPosts = publicPosts.slice(0, 10);

    if (topPosts.length === 0) {
      console.log('No public posts found after filtering.');
      process.exit(0);
    }

    console.log(`Processing top ${topPosts.length} newest public posts...`);

    // Launch Puppeteer browser
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    // Process each post
    const posts = [];
    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      const postId = sanitizePostId(post.attributes.url);

      console.log(`\n[${i + 1}/${topPosts.length}] Processing: "${post.attributes.title}"`);
      console.log(`   Post ID: ${postId}`);
      console.log(`   Date: ${post.attributes.published_at}`);
      console.log(`   URL: ${post.attributes.url}`);

      const imageUrl = findImageForPost(post);
      let thumbnailPath = null;

      if (imageUrl) {
        console.log(`   Found image URL: ${imageUrl}`);
        thumbnailPath = await screenshotAndResizeImage(imageUrl, postId, browser);
      } else {
        console.log(`   ✗ No suitable image found`);
      }

      posts.push({
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnailPath,
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      });
    }

    console.log('\nCleaning up unused thumbnails...');
    const activeThumbnails = new Set(posts.map(p => p.thumbnail ? path.basename(p.thumbnail) : null).filter(Boolean));
    const files = fs.readdirSync(THUMBNAIL_DIR);
    let deletedCount = 0;

    files.forEach(file => {
      if (file.endsWith('.png') && !activeThumbnails.has(file)) {
        try {
          const filePath = path.join(THUMBNAIL_DIR, file);
          fs.unlinkSync(filePath);
          console.log(`   ✓ Deleted unused thumbnail: ${file}`);
          deletedCount++;
        } catch (error) {
          console.error(`   ✗ Failed to delete ${file}: ${error.message}`);
        }
      }
    });

    if (deletedCount === 0) {
      console.log('   No unused thumbnails to delete.');
    } else {
      console.log(`   ✓ Deleted ${deletedCount} unused thumbnails.`);
    }
    // Close browser
    if (browser) {
      await browser.close();
    }

    // Create output JSON
    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts available' : '',
      posts: posts
    };

    // Save to file
    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    console.log(`\n✓ Successfully saved ${posts.length} newest public posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }

  // Fetch members
  const { allMembers, allIncluded } = await fetchPatreonMembers();
  const finalMembers = processMembers(allMembers, allIncluded);
  
  const jsonContent = {
    last_updated: new Date().toISOString(),
    total_members: finalMembers.length,
    members: finalMembers
  };
  
  // Save to file
  fs.writeFileSync("patreon-members.json", JSON.stringify(jsonContent, null, 2));
  console.log(`Saved ${finalMembers.length} members`);
}


main();
