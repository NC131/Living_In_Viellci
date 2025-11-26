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
        'User-Agent': 'Living_In_Viellci'
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

function extractAllImagesFromContent(content) {
  if (!content) return [];

  const images = [];
  const imgMatches = content.matchAll(/<img[^>]+src="([^">]+)"/g);

  for (const match of imgMatches) {
    const url = match[1];
    // Store all images with their type
    images.push({
      url: url,
      isPng: url.match(/\.png(\?|$)/i) !== null,
      isGif: url.match(/\.gif(\?|$)/i) !== null
    });
  }

  return images;
}

function findImageForPost(post) {
  // Get all images from content
  const allImages = extractAllImagesFromContent(post.attributes.content);

  // Find the first PNG
  const firstPng = allImages.find(img => img.isPng);
  if (firstPng) {
    return firstPng.url;
  }

  // If no PNG, check embed_data
  if (post.attributes.embed_data && post.attributes.embed_data.image) {
    const embedImage = post.attributes.embed_data.image.large_thumb_url ||
                       post.attributes.embed_data.image.small_thumb_url ||
                       post.attributes.embed_data.image.url;

    if (embedImage && embedImage.match(/\.png(\?|$)/i)) {
      return embedImage;
    }
  }

  // Check embed_url for PNG
  if (post.attributes.embed_url && post.attributes.embed_url.match(/\.png(\?|$)/i)) {
    return post.attributes.embed_url;
  }

  // If still no PNG found, return first non-GIF image
  const firstNonGif = allImages.find(img => !img.isGif);
  if (firstNonGif) {
    return firstNonGif.url;
  }

  return null;
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

    const posts = topPosts.map((post, i) => {
      const thumbnail = findImageForPost(post);

      console.log(`#${i + 1}: "${post.attributes.title}"`);
      console.log(`   Date: ${post.attributes.published_at}`);
      console.log(`   URL: ${post.attributes.url}`);
      console.log(`   Thumbnail: ${thumbnail ? '✓ ' + thumbnail.substring(0, 80) + '...' : '✗ No image'}\n`);

      return {
        title: post.attributes.title,
        url: post.attributes.url,
        thumbnail: thumbnail,
        date: post.attributes.published_at,
        is_public: post.attributes.is_public
      };
    });

    const output = {
      last_updated: new Date().toISOString(),
      total_posts: posts.length,
      note: 'Thumbnail URLs are from Patreon CDN and may require user to be logged in to view',
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
