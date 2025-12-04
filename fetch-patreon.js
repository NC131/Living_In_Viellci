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
const ID_MAPPING_FILE = path.join(__dirname, 'id-mapping.json');

const TIER_NAME_MAP = {
  "9596103": "Tourist",
  "9115228": "Citizen",
  "9115236": "Landlord",
  "10450352": "Former"
};

const TIER_PRIORITY = {
  "Tourist": 1,
  "Citizen": 2,
  "Landlord": 3
};

function loadIdMapping() {
  if (fs.existsSync(ID_MAPPING_FILE)) {
    try {
      const data = fs.readFileSync(ID_MAPPING_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.warn('Could not parse id-mapping.json, starting fresh.');
      return {};
    }
  }
  return {};
}

function saveIdMapping(mapping) {
  fs.writeFileSync(ID_MAPPING_FILE, JSON.stringify(mapping, null, 2));
}

function generateAnonymousId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getAnonymousId(patreonId, mapping) {
  if (!patreonId) return null;

  for (const [anonId, realId] of Object.entries(mapping)) {
    if (realId === patreonId) {
      return anonId;
    }
  }

  let newAnonId;
  do {
    newAnonId = generateAnonymousId();
  } while (mapping[newAnonId]);

  mapping[newAnonId] = patreonId;
  return newAnonId;
}

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;

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
  let rawMembers = [];
  let nextUrl = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/members?include=user,currently_entitled_tiers&fields[member]=patron_status,full_name`;

  while (nextUrl) {
    const response = await fetchPatreonPage(nextUrl);
    if (!response) break;

    if (response.data) rawMembers = rawMembers.concat(response.data);
    nextUrl = response.links?.next || null;
  }

  return rawMembers;
}

function processMembers(rawMembers) {
  console.log(`\nProcessing members...`);

  const idMapping = loadIdMapping();
  console.log(`   Loaded ${Object.keys(idMapping).length} existing ID mappings`);

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

  const FORMER_TIER_ID = "10450352";
  const processedAnonIds = new Set();
  const finalMembers = [];

  rawMembers.forEach(member => {
    const realMemberId = member.id || null;
    if (!realMemberId) return;

    const anonMemberId = getAnonymousId(realMemberId, idMapping);
    const currentName = member.attributes.full_name?.trim() || "Unknown";

    if (processedAnonIds.has(anonMemberId)) {
      console.log(`   Skipping duplicate anonymous ID: ${anonMemberId}`);
      return;
    }
    processedAnonIds.add(anonMemberId);

    let existingMember = existing.find(m =>
      m.id === realMemberId || m.id === anonMemberId
    );

    if (!existingMember && currentName !== "Unknown") {
      existingMember = existing.find(m => m.name === currentName);
      if (existingMember) {
        console.log(`   Matched by name: "${currentName}"`);
      }
    }

    const rawTierIds =
      member.relationships?.currently_entitled_tiers?.data.map(t => t.id) || [];
    const paidTierIds = rawTierIds.filter(id => id !== FORMER_TIER_ID);

    if (paidTierIds.length === 0) {
      const previousHasPaid = existingMember?.pledge_levels?.some(p => p !== "Former");
      if (!previousHasPaid) {
        return;
      }

      finalMembers.push({
        id: anonMemberId,
        name: currentName,
        pledge_levels: existingMember?.pledge_levels || [],
        is_active: false,
        additional_note: existingMember?.additional_note || ""
      });
      return;
    }

    const tierNames = [...new Set(paidTierIds.map(id => TIER_NAME_MAP[id]).filter(Boolean))];
    const highestTier = tierNames.sort((a, b) =>
      (TIER_PRIORITY[b] || 0) - (TIER_PRIORITY[a] || 0)
    )[0] || tierNames[0] || null;

    const mergedLevels = existingMember
      ? Array.from(new Set([...(existingMember.pledge_levels || []), ...tierNames]))
      : tierNames;

    finalMembers.push({
      id: anonMemberId,
      name: currentName,
      pledge_levels: mergedLevels,
      is_active: highestTier,
      additional_note: existingMember?.additional_note || ""
    });
  });

  existing.forEach(existingMember => {
    let anonId = existingMember.id;

    for (const [anon, real] of Object.entries(idMapping)) {
      if (real === existingMember.id) {
        anonId = anon;
        break;
      }
    }

    if (processedAnonIds.has(anonId)) {
      return;
    }

    if (existingMember.name) {
      const wasMatchedByName = finalMembers.some(m => m.name === existingMember.name);
      if (wasMatchedByName) {
        return;
      }
    }

    const hasPaidHistory = existingMember.pledge_levels?.some(p => p !== "Former");
    if (hasPaidHistory) {
      console.log(`   Keeping former member not in API: "${existingMember.name}"`);
      finalMembers.push({
        id: anonId,
        name: existingMember.name,
        pledge_levels: existingMember.pledge_levels || [],
        is_active: false,
        additional_note: existingMember.additional_note || ""
      });
    }
  });

  finalMembers.sort((a, b) => {
    if (a.is_active && !b.is_active) return -1;
    if (!a.is_active && b.is_active) return 1;

    if (a.is_active && b.is_active) {
      const aPriority = TIER_PRIORITY[a.is_active] || 0;
      const bPriority = TIER_PRIORITY[b.is_active] || 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
    }

    return a.name.localeCompare(b.name);
  });

  console.log(`   Processed ${finalMembers.length} total members`);
  console.log(`   Active: ${finalMembers.filter(m => m.is_active).length}`);
  console.log(`   Former: ${finalMembers.filter(m => !m.is_active).length}`);

  saveIdMapping(idMapping);
  console.log(`   Saved ${Object.keys(idMapping).length} ID mappings to id-mapping.json`);

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
  const rawMembers = await fetchPatreonMembers();
  const finalMembers = processMembers(rawMembers);

  fs.writeFileSync("patreon-members.json", JSON.stringify({
      last_updated: new Date().toISOString(),
      total_members: finalMembers.length,
      members: finalMembers
    }, null, 2));
  console.log(`Saved ${finalMembers.length} members`);
}


main();
