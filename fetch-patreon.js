const fs = require('fs');
const https = require('https');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;
const IMAGES_DIR = 'patreon/posts';

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.patreon.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      }
    };

    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', (error) => {
      reject(error);
    });
  });
}

async function resizeAndSaveImage(imageBuffer, outputPath) {
  try {
    // Load the image
    const img = await loadImage(imageBuffer);
    
    // Calculate resize dimensions (fit within 425x221)
    const targetWidth = 425;
    const targetHeight = 221;
    const scale = Math.min(targetWidth / img.width, targetHeight / img.height);
    const newWidth = Math.floor(img.width * scale);
    const newHeight = Math.floor(img.height * scale);
    
    // Create canvas and resize
    const canvas = createCanvas(newWidth, newHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, newWidth, newHeight);
    
    // Save as PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    
    return true;
  } catch (error) {
    console.error(`Failed to resize image: ${error.message}`);
    return false;
  }
}

function extractFirstPngFromContent(content) {
  if (!content) return null;
  
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  
  while ((match = imgRegex.exec(content)) !== null) {
    const url = match[1];
    if (url.toLowerCase().match(/\.png(\?|$)/)) {
      return url;
    }
  }
  
  return null;
}

function findImageForPost(post) {
  const attrs = post.attributes;
  
  // If it's an image post, use embed_data image
  if (attrs.embed_data && attrs.embed_data.image) {
    const imgData = attrs.embed_data.image;
    const possibleUrls = [
      imgData.large_thumb_url,
      imgData.thumb_url,
      imgData.url
    ];
    
    for (const url of possibleUrls) {
      if (url && url.toLowerCase().match(/\.png(\?|$)/)) {
        return url;
      }
    }
  }
  
  // If embed_url is a PNG
  if (attrs.embed_url && attrs.embed_url.toLowerCase().match(/\.png(\?|$)/)) {
    return attrs.embed_url;
  }
  
  // Extract first PNG from content
  const contentImage = extractFirstPngFromContent(attrs.content);
  if (contentImage) {
    return contentImage;
  }
  
  return null;
}

function generateSafeFilename(postUrl) {
  // Convert /posts/weekly-log-11-144156455 to weekly_log_11_144156455.png
  return postUrl.replace('/posts/', '').replace(/[/-]/g, '_') + '.png';
}

function cleanupOldImages(currentFilenames) {
  // Remove images that are no longer in the top 10
  const existingFiles = fs.readdirSync(IMAGES_DIR);
  
  for (const file of existingFiles) {
    if (file.endsWith('.png') && !currentFilenames.includes(file)) {
      const filePath = path.join(IMAGES_DIR, file);
      fs.unlinkSync(filePath);
      console.log(`   🗑 Deleted old image: ${file}`);
    }
  }
}

async function main() {
  try {
    console.log('Fetching all Patreon posts...');

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

    // Filter public posts with PNG thumbnails
    const publicPostsWithImages = allPosts.filter(post => {
      if (!post.attributes.is_public) {
        return false;
      }
      
      const thumbnail = findImageForPost(post);
      return thumbnail !== null;
    });

    // Sort by published date, newest first
    publicPostsWithImages.sort((a, b) => {
      const dateA = new Date(a.attributes.published_at);
      const dateB = new Date(b.attributes.published_at);
      return dateB.getTime() - dateA.getTime();
    });

    // Take only the top 10 newest public posts with PNG images
    const postsToProcess = publicPostsWithImages.slice(0, 10);

    if (postsToProcess.length === 0) {
      console.log('No public posts with PNG images found after filtering.');
      process.exit(0);
    }

    console.log(`\nProcessing top ${postsToProcess.length} newest public posts with PNG images...`);

    // Download and resize images
    const posts = [];
    const currentFilenames = [];
    
    for (let i = 0; i < postsToProcess.length; i++) {
      const post = postsToProcess[i];
      const thumbnailUrl = findImageForPost(post);
      const filename = generateSafeFilename(post.attributes.url);
      const imagePath = path.join(IMAGES_DIR, filename);
      
      currentFilenames.push(filename);
      
      console.log(`\n   #${i + 1}: "${post.attributes.title}"`);
      console.log(`      Date: ${post.attributes.published_at}`);
      console.log(`      URL: ${post.attributes.url}`);
      console.log(`      Image: ${filename}`);

      // Check if image already exists
      if (fs.existsSync(imagePath)) {
        console.log(`      ✓ Image already exists, skipping download`);
        
        posts.push({
          title: post.attributes.title,
          url: post.attributes.url,
          thumbnail: `patreon/posts/${filename}`,
          date: post.attributes.published_at,
          is_public: post.attributes.is_public
        });
        continue;
      }

      try {
        console.log(`      Downloading...`);
        const imageBuffer = await downloadImageBuffer(thumbnailUrl);
        
        console.log(`      Resizing to fit 425x221...`);
        const success = await resizeAndSaveImage(imageBuffer, imagePath);
        
        if (success) {
          const fileSize = fs.statSync(imagePath).size;
          console.log(`      ✓ Saved (${Math.round(fileSize / 1024)}KB)`);
          
          posts.push({
            title: post.attributes.title,
            url: post.attributes.url,
            thumbnail: `patreon/posts/${filename}`,
            date: post.attributes.published_at,
            is_public: post.attributes.is_public
          });
        }
      } catch (error) {
        console.error(`      ✗ Failed: ${error.message}`);
        // Skip posts with failed image downloads
      }
    }

    if (posts.length === 0) {
      console.log('\nNo posts with successfully downloaded images.');
      process.exit(0);
    }

    // Clean up old images
    console.log('\nCleaning up old images...');
    cleanupOldImages(currentFilenames);

    // Create JSON output
    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts with PNG images available' : '',
      posts: posts
    };

    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    
    const jsonSize = fs.statSync('patreon-posts.json').size;
    console.log(`\n✓ Successfully saved ${posts.length} posts to patreon-posts.json (${Math.round(jsonSize / 1024)}KB)`);
    console.log(`✓ Images saved to ${IMAGES_DIR}/`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    process.exit(1);
  }
}

main();
