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
    return post.attributes.embed_data.image.large_thumb_url ||
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
    console.log('Fetching latest Patreon posts (newest first)...');

    // Properly encode query parameters
    const query = new URLSearchParams({
      'fields[post]': 'title,url,published_at,is_public,content,embed_data,embed_url',
      'page[count]': '50',  // Higher count for efficiency (fetch more per page)
      'sort': '-published_at'  // Newest first
    });

    let allPublicPosts = [];
    let nextUrl = `${API_URL}?${query.toString()}`;
    let pageCount = 0;

    while (nextUrl && allPublicPosts.length < 10) {
      pageCount++;
      console.log(`Fetching page ${pageCount} (newest first): ${nextUrl}`);
      const response = await fetchPatreonPage(nextUrl);

      if (!response.data || response.data.length === 0) {
        console.log(`Page ${pageCount} has no posts.`);
        break;
      }

      // Filter public posts from this page
      const publicPostsFromPage = response.data
        .filter(post => post.attributes.is_public)
        .map(post => ({
          title: post.attributes.title,
          url: post.attributes.url,
          thumbnail: findImageForPost(post),
          date: post.attributes.published_at,
          is_public: post.attributes.is_public
        }));

      allPublicPosts = allPublicPosts.concat(publicPostsFromPage);
      console.log(`Fetched ${response.data.length} posts from page ${pageCount}, found ${publicPostsFromPage.length} public (total public so far: ${allPublicPosts.length})`);

      nextUrl = response.links && response.links.next ? response.links.next : null;
    }

    if (allPublicPosts.length === 0) {
      console.log('No public posts found.');
      process.exit(0);
    }

    // Take only the top 10 newest public posts (already in order due to API sort)
    const posts = allPublicPosts.slice(0, 10);

    // Log processing details
    posts.forEach((post, i) => {
      console.log(`Processing #${i + 1}: "${post.title}" (Date: ${post.date})`);
      console.log(`   URL: ${post.url}`);
      console.log(`   Thumbnail: ${post.thumbnail ? '✓ ' + post.thumbnail : '✗'}`);
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
