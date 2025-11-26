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

async function downloadImage(url, filepath, useAuth = true) {
  return new Promise((resolve, reject) => {
    const options = useAuth ? {
      headers: {
        'Authorization': `Bearer ${PATREON_ACCESS_TOKEN}`,
        'User-Agent': 'Living-In-Viellci-Game/1.0'
      }
    } : {
      headers: {
        'User-Agent': 'Living-In-Viellci-Game/1.0'
      }
    };

    https.get(url, options, (response) => {
      // Follow redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadImage(response.headers.location, filepath, useAuth)
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
    console.log(`   Resized image to ${width}x${height}`);
  } catch (error) {
    console.warn(`   Warning: Could not resize image (jimp not installed). Using original size.`);
    fs.copyFileSync(inputPath, outputPath);
  }
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 50);
}

function findFirstPngMedia(included, post) {
  if (!included || !Array.isArray(included)) return null;

  // Get media relationships from post
  const mediaRelationships = post.relationships?.media?.data;
  if (!mediaRelationships || !Array.isArray(mediaRelationships)) return null;

  // Find media items in included array
  for (const mediaRef of mediaRelationships) {
    const media = included.find(item => item.type === 'media' && item.id === mediaRef.id);

    if (media && media.attributes) {
      const downloadUrl = media.attributes.download_url;
      const imageUrl = media.attributes.image_urls?.default ||
                       media.attributes.image_urls?.original ||
                       downloadUrl;

      // Check if it's a PNG
      if (imageUrl && imageUrl.match(/\.png(\?|$)/i)) {
        return imageUrl;
      }
    }
  }

  return null;
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

function findImageForPost(post, included) {
  // Get from media attachments
  const mediaImage = findFirstPngMedia(included, post);
  if (mediaImage) {
    return mediaImage;
  }

  // Then try embed_data
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;

    if (embedImage && embedImage.match(/\.png(\?|$)/i)) {
      return embedImage;
    }
  }

  // Check embed_url
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.png(\?|$)/i)) {
    return post.attributes.embed_url;
  }

  // Finally extract from content
  return extractFirstPngFromContent(post.attributes.content);
}

async function processPostThumbnail(post, included, index) {
  const imageUrl = findImageForPost(post, included);

  if (!imageUrl) {
    console.log(`   No PNG thumbnail found`);
    return null;
  }

  try {
    const sanitizedTitle = sanitizeFilename(post.attributes.title);
    const filename = `${index}_${sanitizedTitle}.png`;
    const tempPath = path.join(THUMBNAIL_DIR, `temp_${filename}`);
    const finalPath = path.join(THUMBNAIL_DIR, filename);

    console.log(`   Downloading: ${imageUrl.substring(0, 80)}...`);

    // Try with authorization first
    try {
      await downloadImage(imageUrl, tempPath, true);
    } catch (authError) {
      console.log(`   Auth download failed, trying without auth...`);
      await downloadImage(imageUrl, tempPath, false);
    }

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

    // Include media and attachments in the query
    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'fields[media]': 'download_url,image_urls,file_name',
      'include': 'media',
      'page[count]': '100'
    });

    let allPosts = [];
    let allIncluded = [];
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

      // Collect included media
      if (response.included && Array.isArray(response.included)) {
        allIncluded = allIncluded.concat(response.included);
      }

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

      const thumbnailPath = await processPostThumbnail(post, allIncluded, i + 1);

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
