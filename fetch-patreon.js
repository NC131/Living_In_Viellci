const fs = require('fs');
const https = require('https');
const path = require('path');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

const THUMBNAIL_DIR = path.join(__dirname, 'patreon', 'posts');

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  console.log(`Created directory: ${THUMBNAIL_DIR}`);
}

const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;

function fetchPatreonPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Bearer ${PATREON_ACCESS_TOKEN}`,
        'User-Agent': 'Living In Viellci'
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

function fetchPostHtml(postUrl) {
  return new Promise((resolve, reject) => {
    const fullUrl = postUrl.startsWith('http') ? postUrl : `https://www.patreon.com${postUrl}`;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };

    https.get(fullUrl, options, (res) => {
      let data = '';

      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchPostHtml(res.headers.location).then(resolve).catch(reject);
        return;
      }

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function extractImageFromHtml(html) {
  if (!html) return null;

  // Look for image meta tag
  const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImageMatch && ogImageMatch[1]) {
    const url = ogImageMatch[1];
    // Check if it's a PNG
    if (url.match(/\.png(\?|$)/i)) {
      return url;
    }
  }

  // Look for first image in content that's a PNG
  const imgMatches = html.matchAll(/<img[^>]+src="([^"]+\.png[^"]*)"/gi);
  for (const match of imgMatches) {
    if (match[1] && !match[1].includes('avatar') && !match[1].includes('icon')) {
      return match[1];
    }
  }

  return null;
}

async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.patreon.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    };

    https.get(url, options, (response) => {
      // Follow redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadImage(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(filepath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filepath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function resizeImage(inputPath, outputPath, width = 425, height = 221) {
  try {
    const Jimp = require('jimp');
    const image = await Jimp.read(inputPath);
    await image.resize(width, height).quality(90).writeAsync(outputPath);
    console.log(`   Resized to ${width}x${height}`);
  } catch (error) {
    console.warn(`   Warning: Could not resize (jimp not installed). Using original.`);
    if (inputPath !== outputPath) {
      fs.copyFileSync(inputPath, outputPath);
    }
  }
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 50);
}

function extractFirstPngFromContent(content) {
  if (!content) return null;

  const imgMatches = content.matchAll(/<img[^>]+src="([^">]+)"/g);

  for (const match of imgMatches) {
    const url = match[1];
    if (url.match(/\.png(\?|$)/i)) {
      return url;
    }
  }

  return null;
}

async function processPostThumbnail(post, index) {
  try {
    const sanitizedTitle = sanitizeFilename(post.attributes.title);
    const filename = `${index}_${sanitizedTitle}.png`;
    const tempPath = path.join(THUMBNAIL_DIR, `temp_${filename}`);
    const finalPath = path.join(THUMBNAIL_DIR, filename);

    // Get PNG from post content
    let imageUrl = extractFirstPngFromContent(post.attributes.content);

    // If no PNG found in API content, scrape the actual post page
    if (!imageUrl) {
      console.log(`   No PNG in API response, scraping post page...`);
      const postHtml = await fetchPostHtml(post.attributes.url);
      imageUrl = extractImageFromHtml(postHtml);
    }

    if (!imageUrl) {
      console.log(`   No PNG thumbnail found`);
      return null;
    }

    console.log(`   Found image: ${imageUrl.substring(0, 80)}...`);
    console.log(`   Downloading...`);

    await downloadImage(imageUrl, tempPath);

    console.log(`   Resizing...`);
    await resizeImage(tempPath, finalPath, 425, 221);

    if (fs.existsSync(tempPath) && tempPath !== finalPath) {
      fs.unlinkSync(tempPath);
    }

    return `patreon/posts/${filename}`;
  } catch (error) {
    console.error(`   Error: ${error.message}`);
    return null;
  }
}

async function main() {
  try {
    console.log('Fetching all Patreon posts...\n');

    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'page[count]': '100'
    });

    let allPosts = [];
    let nextUrl = `${API_URL}?${query.toString()}`;
    let pageCount = 0;

    while (nextUrl) {
      pageCount++;
      console.log(`Fetching page ${pageCount}...`);
      const response = await fetchPatreonPage(nextUrl);

      if (!response.data || response.data.length === 0) {
        break;
      }

      allPosts = allPosts.concat(response.data);
      console.log(`  Fetched ${response.data.length} posts (total: ${allPosts.length})`);

      nextUrl = response.links && response.links.next ? response.links.next : null;
    }

    if (allPosts.length === 0) {
      console.log('No posts found.');
      process.exit(0);
    }

    console.log(`\nTotal posts: ${allPosts.length}`);

    const publicPosts = allPosts.filter(post => post.attributes.is_public);

    publicPosts.sort((a, b) => {
      const dateA = new Date(a.attributes.published_at);
      const dateB = new Date(b.attributes.published_at);
      return dateB.getTime() - dateA.getTime();
    });

    const topPosts = publicPosts.slice(0, 10);

    if (topPosts.length === 0) {
      console.log('No public posts found.');
      process.exit(0);
    }

    console.log(`\nProcessing ${topPosts.length} newest public posts:\n`);

    const posts = [];
    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      console.log(`#${i + 1}: "${post.attributes.title}"`);
      console.log(`   Date: ${post.attributes.published_at}`);
      console.log(`   URL: ${post.attributes.url}`);

      const thumbnailPath = await processPostThumbnail(post, i + 1);

      posts.push({
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnailPath,
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      });

      console.log(`   Result: ${thumbnailPath ? '✓ ' + thumbnailPath : '✗ No PNG'}\n`);
    }

    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts available' : '',
      posts: posts
    };

    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    console.log(`✓ Successfully saved ${posts.length} posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
