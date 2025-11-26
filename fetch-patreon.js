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
    // Only return .png images, skip GIFs
    if (imgUrl.match(/\.png(\?|$)/i)) {
      return imgUrl;
    }
  }

  return null;
}

function findImageForPost(post, included) {
  // Check for image in post_file (main post image attachment)
  if (post.attributes.post_file && post.attributes.post_file.url) {
    console.log(`   Found main post image from post_file`);
    return post.attributes.post_file.url;
  }

  // Check for image in image attribute
  if (post.attributes.image && post.attributes.image.url) {
    console.log(`   Found main post image from image attribute`);
    return post.attributes.image.url;
  }

  // Check if it's a video post with embed data
  // For videos, we want to extract from content (your custom thumbnail)
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    console.log(`   Detected video/embed post, checking content for thumbnail...`);
    const contentImage = extractFirstImageFromContent(post.attributes.content);
    if (contentImage) {
      console.log(`   Found custom thumbnail in video post content`);
      return contentImage;
    }

    // Fallback to embed thumbnail if no content image
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;
    if (embedImage) {
      console.log(`   Using embed thumbnail as fallback`);
      return embedImage;
    }
  }

  // Check embed_url, but only if it's a PNG
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.png(\?|$)/i)) {
    console.log(`   Found PNG in embed_url`);
    return post.attributes.embed_url;
  }

  // Extract first PNG image from content (last resort)
  const contentImage = extractFirstImageFromContent(post.attributes.content);
  if (contentImage) {
    console.log(`   Found image in post content`);
    return contentImage;
  }

  return null;
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

function cleanupOldThumbnails(currentPostIds) {
  // Get all PNG files in the thumbnail directory
  const files = fs.readdirSync(THUMBNAIL_DIR).filter(file => file.endsWith('.png'));

  // Create a set of current post IDs for faster lookup
  const currentIds = new Set(currentPostIds.map(id => `${id}.png`));

  // Delete files that aren't in the current post list
  let deletedCount = 0;
  files.forEach(file => {
    if (!currentIds.has(file)) {
      const filepath = path.join(THUMBNAIL_DIR, file);
      fs.unlinkSync(filepath);
      console.log(`   🗑️  Deleted old thumbnail: ${file}`);
      deletedCount++;
    }
  });

  if (deletedCount > 0) {
    console.log(`\n✓ Cleaned up ${deletedCount} old thumbnail(s)`);
  } else {
    console.log(`\n✓ No old thumbnails to clean up`);
  }
}

async function main() {
  let browser = null;

  try {
    console.log('Fetching all Patreon posts...');

    // Request post data with image and post_file fields
    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url,image,post_file',
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

    // Manually sort by published date, newest first (descending)
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
    const processedPostIds = [];

    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      const postId = sanitizePostId(post.attributes.url);
      processedPostIds.push(postId);

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

    // Close browser
    if (browser) {
      await browser.close();
    }

    // Clean up old thumbnails that are no longer in the top 10
    console.log('\nCleaning up old thumbnails...');
    cleanupOldThumbnails(processedPostIds);

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
}

main();
