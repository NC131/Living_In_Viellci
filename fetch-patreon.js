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
        'User-Agent': 'Living-In-Viellci-Game/1.0'
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

async function scrapePostBanner(postUrl, postId, browser) {
  try {
    const fullUrl = postUrl.startsWith('http')
      ? postUrl
      : `https://www.patreon.com${postUrl}`;

    console.log(`   Scraping banner from: ${fullUrl}`);

    const page = await browser.newPage();
    await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 40000 });

    let bannerUrl = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:image"]');
      return meta ? meta.content : null;
    });

    if (bannerUrl) {
      console.log(`   ✓ Found OG image: ${bannerUrl}`);
      await page.close();
      return await screenshotAndResizeImage(bannerUrl, postId, browser);
    }

    const selectors = [
      'img[src*="patreonusercontent"]',
      '.sc-AxheI img',
      'figure img',
      '.post__image img'
    ];

    for (const sel of selectors) {
      bannerUrl = await page.$eval(sel, img => img.src).catch(() => null);
      if (bannerUrl) {
        console.log(`   ✓ Found banner via selector "${sel}": ${bannerUrl}`);
        await page.close();
        return await screenshotAndResizeImage(bannerUrl, postId, browser);
      }
    }

    await page.close();
    console.log('   ✗ No banner image found via scraping.');
    return null;

  } catch (error) {
    console.error(`   ✗ Scraping error: ${error.message}`);
    return null;
  }
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

    await page.setViewport({ width: 1920, height: 1080 });

    const html = `
      <html>
      <body style="margin:0;display:flex;align-items:center;justify-content:center;background:#000;">
        <img src="${imageUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;">
      </body>
      </html>
    `;

    await page.setContent(html);
    const imageElement = await page.$('img');

    const buffer = await imageElement.screenshot({ type: 'png' });
    await page.close();

    const resizedBuffer = await sharp(buffer)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'cover', position: 'center' })
      .png()
      .toBuffer();

    const filename = `${postId}.png`;
    fs.writeFileSync(path.join(THUMBNAIL_DIR, filename), resizedBuffer);

    console.log(`   ✓ Thumbnail saved: ${filename}`);
    return `patreon/posts/${filename}`;
  } catch (error) {
    console.error(`   ✗ Screenshot error: ${error.message}`);
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
    console.log('Fetching posts...');

    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'page[count]': '100'
    });

    let allPosts = [];
    let nextUrl = `${API_URL}?${query.toString()}`;

    while (nextUrl) {
      const response = await fetchPatreonPage(nextUrl);
      allPosts = allPosts.concat(response.data);
      nextUrl = response.links?.next || null;
    }

    const publicPosts = allPosts
      .filter(p => p.attributes.is_public)
      .sort((a, b) => new Date(b.attributes.published_at) - new Date(a.attributes.published_at))
      .slice(0, 10);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu']
    });

    const posts = [];
    
    for (const post of publicPosts) {
      const postId = sanitizePostId(post.attributes.url);
      console.log(`\nProcessing: "${post.attributes.title}"`);

      let thumbnailPath = await scrapePostBanner(normalizeURL(post.attributes.url), postId, browser);

      if (!thumbnailPath) {
        const imageUrl = findImageForPost(post);
        if (imageUrl) {
          console.log(`   Found fallback image: ${imageUrl}`);
          thumbnailPath = await screenshotAndResizeImage(imageUrl, postId, browser);
        }
      }

      posts.push({
        title: post.attributes.title,
        url: normalizeURL(post.attributes.url),
        thumbnail: thumbnailPath,
        date: post.attributes.published_at
      });
    }

    fs.writeFileSync('patreon-posts.json', JSON.stringify({
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      posts
    }, null, 2));

    console.log('\n✓ All done.');
  } catch (error) {
    console.error('Fatal error:', error.message);
  } finally {
    if (browser) await browser.close();
  }
}

main();
