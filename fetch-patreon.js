const fs = require('fs');
const https = require('https');
const path = require('path');
const sharp = require('sharp');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

// Patreon API endpoint
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

// Download an image from a URL and return as buffer
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download image: status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Extract first .png URL from content (case-insensitive)
function extractThumbnailFromContent(content) {
  if (!content) return null;
  const imgMatch = content.match(/<img[^>]+src="([^">]+?\.png)"/i);  // Only match .png
  return imgMatch ? imgMatch[1] : null;
}

// Find the first .png image, prioritizing embed_data > embed_url > content.
// Special handling for videos: Force fallback to content if no PNG elsewhere.
async function findImageForPost(post) {
  const isVideo = post.attributes.post_type && post.attributes.post_type.includes('video');  // Detect video posts

  // Helper to check if URL is PNG (case-insensitive)
  const isPng = (url) => url && url.match(/\.png$/i);

  // Check embed_data for PNG
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    const candidates = [
      post.attributes.embed_data.image.large_thumb_url,
      post.attributes.embed_data.image.small_thumb_url,
      post.attributes.embed_data.image.url
    ];
    const pngUrl = candidates.find(isPng);
    if (pngUrl) return pngUrl;
  }

  // Check embed_url if it's a PNG
  if (post.attributes.embed_url && isPng(post.attributes.embed_url)) {
    return post.attributes.embed_url;
  }

  // Fallback to content extraction (always for videos if above failed)
  if (isVideo || true) {  // Always fallback, but required for videos
    const contentThumb = extractThumbnailFromContent(post.attributes.content);
    if (contentThumb) return contentThumb;
  }

  return null;  // No PNG found
}

async function main() {
  try {
    console.log('Fetching all Patreon posts...');

    // Add post_type to fields for video detection
    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url,post_type',
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
    const posts = [];
    for (const post of publicPosts.slice(0, 10)) {
      const thumbnailUrl = await findImageForPost(post);  // Get PNG URL

      let thumbnailPath = null;
      if (thumbnailUrl) {
        try {
          // Download image
          const imageBuffer = await downloadImage(thumbnailUrl);

          // Create folder if needed
          const outputDir = path.join(__dirname, 'patreon', 'posts');
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }

          // Resize to 425x221 and save as PNG
          const filename = `${post.id}.png`;  // Use post ID for uniqueness
          const outputPath = path.join(outputDir, filename);
          await sharp(imageBuffer)
            .resize(425, 221, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })  // Resize with white background if needed
            .png()  // Ensure output is PNG
            .toFile(outputPath);

          // Set relative repo path
          thumbnailPath = `patreon/posts/${filename}`;
          console.log(`Downloaded and resized thumbnail for post ${post.id}: ${thumbnailPath}`);
        } catch (error) {
          console.error(`Failed to process thumbnail for post ${post.id}: ${error.message}`);
        }
      }

      posts.push({
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnailPath,  // Now a local repo path (or null if no PNG)
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      });
    }

    if (posts.length === 0) {
      console.log('No public posts found after filtering.');
      process.exit(0);
    }

    // Log processing details
    console.log(`Processing top ${posts.length} newest public posts:`);
    posts.forEach((post, i) => {
      console.log(`   #${i + 1}: "${post.title}" (Date: ${post.date})`);
      console.log(`      URL: ${post.url}`);
      console.log(`      Thumbnail: ${post.thumbnail ? '✓ ' + post.thumbnail : '✗ (No PNG found)'}`);
    });

    // Create output JSON
    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts available' : '',
      posts: posts
    };

    // Save to file
    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    console.log(`Successfully saved ${posts.length} newest public posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    process.exit(1);
  }
}

main();
