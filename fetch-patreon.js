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

      res.on('data', chunk => data += chunk);

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

// Extract first PNG from post content
function extractFirstImageFromContent(content) {
  if (!content) return null;
  const imgMatches = content.matchAll(/<img[^>]+src="([^">]+)"/g);
  for (const match of imgMatches) {
    const imgUrl = match[1];
    if (imgUrl.match(/\.png(\?|$)/i)) return imgUrl;
  }
  return null;
}


function findImageForPost(post, included = []) {
  const attrs = post.attributes;

  // Real attached image (best source for image posts)
  if (attrs.post_file && attrs.post_file.url) {
    return attrs.post_file.url;
  }

  // Patreon auto-generated cover image URLs
  if (attrs.image) {
    if (attrs.image.large_url) return attrs.image.large_url;
    if (attrs.image.thumb_url) return attrs.image.thumb_url;
    if (attrs.image.small_url) return attrs.image.small_url;
  }

  // Search "included" media for higher-quality images
  for (const item of included) {
    if (
      item.type === 'media' &&
      item.attributes &&
      (item.attributes.image_urls || item.attributes.download_url)
    ) {
      const urls = item.attributes.image_urls;
      return (
        (urls && (urls.large || urls.default || urls.small)) ||
        item.attributes.download_url
      );
    }
  }

  // Video embed thumbnails
  if (attrs.embed_data && attrs.embed_data.image) {
    return (
      attrs.embed_data.image.large_thumb_url ||
      attrs.embed_data.image.small_thumb_url ||
      attrs.embed_data.image.url
    );
  }

  // find first PNG in content
  return extractFirstImageFromContent(attrs.content);
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
    await page.waitForSelector('img', { timeout: 10000 });
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const img = document.querySelector('img');
        if (img.complete) resolve();
        else {
          img.addEventListener('load', resolve);
          img.addEventListener('error', resolve);
        }
      });
    });

    const imageElement = await page.$('img');
    const screenshotBuffer = await imageElement.screenshot({ type: 'png' });
    await page.close();

    const resizedBuffer = await sharp(screenshotBuffer)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'cover', position: 'center' })
      .png()
      .toBuffer();

    const filepath = path.join(THUMBNAIL_DIR, `${postId}.png`);
    fs.writeFileSync(filepath, resizedBuffer);

    console.log(`   ✓ Saved thumbnail: ${postId}.png`);
    return `patreon/posts/${postId}.png`;

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

    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url,post_file,image',
      'page[count]': '100'
    });

    let allPosts = [];
    let allIncluded = [];
    let nextUrl = `${API_URL}?${query.toString()}`;
    let pageCount = 0;

    // Fetch all pages
    while (nextUrl) {
      pageCount++;
      console.log(`Fetching page ${pageCount}: ${nextUrl}`);
      const response = await fetchPatreonPage(nextUrl);

      if (response.data) {
        allPosts = allPosts.concat(response.data);
      }

      if (response.included) {
        allIncluded = allIncluded.concat(response.included);
      }

      nextUrl = response.links?.next || null;
    }

    if (allPosts.length === 0) {
      console.log('No posts found.');
      process.exit(0);
    }

    console.log(`Total fetched posts: ${allPosts.length}`);

    const publicPosts = allPosts.filter(post => post.attributes.is_public);

    publicPosts.sort((a, b) => new Date(b.attributes.published_at) - new Date(a.attributes.published_at));

    const topPosts = publicPosts.slice(0, 10);

    console.log(`Processing ${topPosts.length} newest public posts...`);

    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const posts = [];
    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      const postId = sanitizePostId(post.attributes.url);

      console.log(`\n[${i + 1}/${topPosts.length}] Processing: "${post.attributes.title}"`);
      console.log(`   Post ID: ${postId}`);
      console.log(`   Date: ${post.attributes.published_at}`);
      console.log(`   URL: ${post.attributes.url}`);

      const imageUrl = findImageForPost(post, allIncluded);
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
    files.forEach(file => {
      if (file.endsWith('.png') && !activeThumbnails.has(file)) {
        fs.unlinkSync(path.join(THUMBNAIL_DIR, file));
        console.log(`   ✓ Deleted unused thumbnail: ${file}`);
      }
    });

    if (browser) await browser.close();

    fs.writeFileSync('patreon-posts.json', JSON.stringify({
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      posts
    }, null, 2));

    console.log(`\n✓ Successfully saved ${posts.length} posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error);
    if (browser) await browser.close();
    process.exit(1);
  }
}

main();
