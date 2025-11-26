const fs = require('fs');
const https = require('https');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
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

function extractFirstPngFromContent(content) {
  if (!content) return null;
  
  // Match all img tags
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  
  while ((match = imgRegex.exec(content)) !== null) {
    const url = match[1];
    // Check if URL ends with .png (case insensitive)
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
    
    // Find first PNG in the embed data
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
  
  // Extract first PNG from content (for video posts with image in description)
  const contentImage = extractFirstPngFromContent(attrs.content);
  if (contentImage) {
    return contentImage;
  }
  
  return null;
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
    const posts = publicPostsWithImages.slice(0, 10).map(post => {
      const thumbnail = findImageForPost(post);

      return {
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnail,
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      };
    });

    if (posts.length === 0) {
      console.log('No public posts with PNG images found after filtering.');
      process.exit(0);
    }

    console.log(`Processing top ${posts.length} newest public posts with PNG images:`);
    posts.forEach((post, i) => {
      console.log(`   #${i + 1}: "${post.title}" (Date: ${post.date})`);
      console.log(`      URL: ${post.url}`);
      console.log(`      Thumbnail: ${post.thumbnail ? '✓ ' + post.thumbnail : '✗'}`);
    });

    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: posts.length < 10 ? 'Fewer than 10 public posts with PNG images available' : '',
      posts: posts
    };

    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));
    console.log(`Successfully saved ${posts.length} newest public posts to patreon-posts.json`);

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    process.exit(1);
  }
}

main();
