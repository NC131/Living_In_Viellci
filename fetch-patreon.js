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

// Ensure thumbnail directory exists
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;

function fetchPatreonPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Bearer ${PATREON_ACCESS_TOKEN}`,
        'User-Agent': 'Living-In-Viellci-Game/1.0'
      }
    };

    https.get(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Patreon API returned status ${res.statusCode}: ${data}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function extractFirstImageFromContent(content) {
  if (!content) return null;

  // Match all img tags
  const imgMatches = content.matchAll(/<img[^>]+src="([^">]+)"/g);

  for (const match of imgMatches) {
    const imgUrl = match[1];
    // Only return .png images, skip GIFs (per your original logic)
    if (imgUrl.match(/\.png(\?|$)/i)) {
      return imgUrl;
    }
  }

  return null;
}

// Updated function to accept the Media Map
function findImageForPost(post, mediaMap) {
  // This is where the "Main" image usually lives in API v2
  if (post.relationships && post.relationships.media && post.relationships.media.data) {
    const mediaData = post.relationships.media.data;
    // mediaData can be an array or object depending on count
    const mediaItems = Array.isArray(mediaData) ? mediaData : [mediaData];

    for (const item of mediaItems) {
      if (mediaMap[item.id]) {
        const mediaObj = mediaMap[item.id];
        if (mediaObj.image_urls && mediaObj.image_urls.original) {
          return mediaObj.image_urls.original;
        }
        if (mediaObj.download_url) {
          return mediaObj.download_url;
        }
      }
    }
  }

  // If it's a video post, your logic to grab the PNG from description applies here
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;

    // If it's a video, try to find first PNG in content (Description) instead
    // This preserves your workflow of putting thumbnails in description for videos
    if (embedImage && !embedImage.match(/\.png(\?|$)/i)) {
      const contentImage = extractFirstImageFromContent(post.attributes.content);
      if (contentImage) {
        return contentImage;
      }
    }

    return embedImage;
  }

  // CHECK EMBED URL
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.png(\?|$)/i)) {
    return post.attributes.embed_url;
  }

  // Extract first PNG image from content (Description)
  return extractFirstImageFromContent(post.attributes.content);
}

async function screenshotAndResizeImage(imageUrl, postId, browser) {
  try {
    console.log(`   Screenshotting image: ${imageUrl}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

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
    await page.waitForSelector('img', { timeout: 20000 }); // Increased timeout slightly
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

    const imageElement = await page.$('img');
    const screenshotBuffer = await imageElement.screenshot({ type: 'png' });

    await page.close();

    const resizedBuffer = await sharp(screenshotBuffer)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
        fit: 'cover',
        position: 'center'
      })
      .png()
      .toBuffer();

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
  const match = url.match(/(\d+)$/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, '-');
}

async function main() {
  let browser = null;

  try {
    console.log('Fetching all Patreon posts...');

    // Request 'media' include and fields
    const query = new URLSearchParams({
      'include': 'media',
      'fields[media]': 'image_urls,download_url,metadata',
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'page[count]': '100'
    });

    let allPosts = [];

    // Map to store included media objects (ID -> Attributes)
    let mediaMap = {};

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

      // 1. Store posts
      allPosts = allPosts.concat(response.data);

      // 2. Store included media in our map
      if (response.included) {
        response.included.forEach(item => {
          if (item.type === 'media') {
            mediaMap[item.id] = item.attributes;
          }
        });
      }

      console.log(`Fetched ${response.data.length} posts from page ${pageCount} (total so far: ${allPosts.length})`);

      nextUrl = response.links && response.links.next ? response.links.next : null;
    }

    if (allPosts.length === 0) {
      console.log('No posts found across all pages.');
      process.exit(0);
    }

    // Filter public posts
    const publicPosts = allPosts.filter(post => post.attributes.is_public);

    // Sort by published date
    publicPosts.sort((a, b) => {
      const dateA = new Date(a.attributes.published_at);
      const dateB = new Date(b.attributes.published_at);
      return dateB.getTime() - dateA.getTime();
    });

    const topPosts = publicPosts.slice(0, 10);

    if (topPosts.length === 0) {
      console.log('No public posts found after filtering.');
      process.exit(0);
    }

    console.log(`Processing top ${topPosts.length} newest public posts...`);

    // Launch Puppeteer
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

    const posts = [];
    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      const postId = sanitizePostId(post.attributes.url);

      console.log(`\n[${i + 1}/${topPosts.length}] Processing: "${post.attributes.title}"`);

      // Pass mediaMap to the finder
      const imageUrl = findImageForPost(post, mediaMap);
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

    // Cleanup Logic (Unchanged)
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

    if (deletedCount > 0) console.log(`   ✓ Deleted ${deletedCount} unused thumbnails.`);

    if (browser) await browser.close();

    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts available' : '',
      posts: posts
    };

    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    console.log(`\n✓ Successfully saved ${posts.length} newest public posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

main();
