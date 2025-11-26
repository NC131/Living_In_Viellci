const fs = require('fs');
const https = require('https');

const PATREON_ACCESS_TOKEN = process.env.PATREON_ACCESS_TOKEN;
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID;

if (!PATREON_ACCESS_TOKEN || !PATREON_CAMPAIGN_ID) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

// Patreon API endpoint
const API_URL = `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts`;
const PARAMS = [
  'fields[post]=title,url,published_at,is_public,content,embed_data,embed_url',
  'page[count]=20' // Fetch 20 per page
].join('&');

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

function extractThumbnailFromContent(content) {
  if (!content) return null;
  const imgMatch = content.match(/<img[^>]+src="([^">]+)"/);
  if (imgMatch && imgMatch[1]) {
    return imgMatch[1];
  }
  return null;
}

function findImageForPost(post) {
  // Prioritize thumbnail fields
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    return post.attributes.embed_data.image.large_thumb_url ||  // Prefer large thumb for quality
           post.attributes.embed_data.image.small_thumb_url ||
           post.attributes.embed_data.image.url;
  }
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
    return post.attributes.embed_url;
  }
  return extractThumbnailFromContent(post.attributes.content);
}

async function main() {
  try {
    console.log('Fetching Patreon posts with pagination...');

    let allPosts = [];
    let nextUrl = `${API_URL}?${PARAMS}`;
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
      console.log('No posts found across all pages...');
      process.exit(0);
    }

    console.log(`Total fetched posts: ${allPosts.length}`);

    // Filter public posts
    const publicPosts = allPosts.filter(post => {
      const isPublic = post.attributes.is_public;
      if (!isPublic) {
        console.log(`Skipping private post: "${post.attributes.title}"`);
      }
      return isPublic;
    });

    // Sort by published date, newest first (descending)
    publicPosts.sort((a, b) => {
      const dateA = new Date(a.attributes.published_at + 'Z'); // Force UTC
      const dateB = new Date(b.attributes.published_at + 'Z');
      return dateA.getTime() - dateB.getTime();  // Corrected for descending (newest first)
    });

    // Take only the top 10 newest public posts
    const posts = publicPosts.slice(0, 10).map(post => {
      const thumbnail = findImageForPost(post);

      console.log(`Processing: "${post.attributes.title}" (Date: ${post.attributes.published_at})`);
      console.log(`URL: ${post.attributes.url}`);
      console.log(`Thumbnail: ${thumbnail ? '✓ ' + thumbnail : '✗'}`);

      return {
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnail,
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      };
    });

    if (posts.length === 0) {
      console.log('No public posts found after filtering');
      process.exit(0);
    }

    // Create output JSON
    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      posts: posts
    };

    // Save to file
    fs.writeFileSync('patreon-posts.json', JSON.stringify(output, null, 2));

    console.log(`Successfully saved ${posts.length} posts to patreon-posts.json`);
    console.log('Summary (newest first):');
    posts.forEach((post, i) => {
      console.log(`   ${i + 1}. ${post.title} (${post.date})`);
    });

  } catch (error) {
    console.error('Error fetching Patreon posts:', error.message);
    process.exit(1);
  }
}

main();
