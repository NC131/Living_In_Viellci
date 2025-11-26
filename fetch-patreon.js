const fs = require('fs');
const https = require('https');
const path = require('path');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

// Directory to save thumbnails
const THUMBNAIL_DIR = path.join(__dirname, 'patreon', 'posts');

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

// Create thumbnail directory if it doesn't exist
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  console.log(`Created directory: ${THUMBNAIL_DIR}`);
}

// Patreon API endpoint
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

function extractFirstPngFromContent(content) {
  if (!content) return null;

  // Match all img tags
  const imgMatches = content.matchAll(/<img[^>]+src="([^">]+)"/g);

  for (const match of imgMatches) {
    const url = match[1];
    // Only return if it's a PNG (case insensitive)
    if (url.match(/\.png(\?|$)/i)) {
      return url;
    }
  }

  return null;
}

function findImageForPost(post) {
  // Find PNG from embed_data
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;

    // Only use if it's a PNG
    if (embedImage && embedImage.match(/\.png(\?|$)/i)) {
      return embedImage;
    }
  }

  // Check embed_url for PNG
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.png(\?|$)/i)) {
    return post.attributes.embed_url;
  }

  // Finally, extract first PNG from content
  return extractFirstPngFromContent(post.attributes.content);
}

async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadImage(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = createWriteStream(filepath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filepath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(filepath, () => {}); // Delete partial file
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function resizeImage(inputPath, outputPath, width = 425, height = 221) {
  // We'll use sharp for image resizing
  // Since sharp is a native module, we need to install it
  // For now, let's use a simpler approach with child_process and ImageMagick
  // Or we can use jimp which is pure JS

  try {
    const Jimp = require('jimp');
    const image = await Jimp.read(inputPath);
    await image.resize(width, height).quality(90).writeAsync(outputPath);
    console.log(`   Resized image to ${width}x${height}: ${outputPath}`);
  } catch (error) {
    // If jimp is not available, just copy the file
    console.warn(`   Warning: Could not resize image (jimp not installed). Using original size.`);
    fs.copyFileSync(inputPath, outputPath);
  }
}

function sanitizeFilename(str) {
  // Remove or replace characters that are invalid in filenames
  return str.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 50);
}

async function processPostThumbnail(post, index) {
  const imageUrl = findImageForPost(post);

  if (!imageUrl) {
    console.log(`   No PNG thumbnail found for post: "${post.attributes.title}"`);
    return null;
  }

  try {
    // Create filename based on post title and index
    const sanitizedTitle = sanitizeFilename(post.attributes.title);
    const filename = `${index}_${sanitizedTitle}.png`;
    const tempPath = path.join(THUMBNAIL_DIR, `temp_${filename}`);
    const finalPath = path.join(THUMBNAIL_DIR, filename);

    console.log(`   Downloading thumbnail: ${imageUrl}`);
    await downloadImage(imageUrl, tempPath);

    console.log(`   Resizing thumbnail...`);
    await resizeImage(tempPath, finalPath, 425, 221);

    // Clean up temp file
    if (fs.existsSync(tempPath) && tempPath !== finalPath) {
      fs.unlinkSync(tempPath);
    }

    // Return relative path for JSON
    return `patreon/posts/${filename}`;
  } catch (error) {
    console.error(`   Error processing thumbnail for "${post.attributes.title}":`, error.message);
    return null;
  }
}

async function main() {
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

    console.log(`\nProcessing top ${topPosts.length} newest public posts:\n`);

    // Process each post and download/resize thumbnails
    const posts = [];
    for (let i = 0; i < topPosts.length; i++) {
      const post = topPosts[i];
      console.log(`Processing #${i + 1}: "${post.attributes.title}"`);
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

      console.log(`   Thumbnail: ${thumbnailPath ? '✓ ' + thumbnailPath : '✗ No PNG found'}\n`);
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
    process.exit(1);
  }
}

main();
