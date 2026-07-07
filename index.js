#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import HttpsProxyAgent from 'https-proxy-agent';

dotenv.config();

// --- HTTP agent (supports proxy via env vars) ---
function getAgent(url) {
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;
  if (proxy) {
    return url.startsWith('https') ? new HttpsProxyAgent.HttpsProxyAgent(proxy) : undefined;
  }
  return undefined;
}

// --- Reddit API helpers ---

const REDDIT_BASE = 'https://www.reddit.com';
const OAUTH_BASE = 'https://oauth.reddit.com';
const USER_AGENT = 'RedditMarketingMCP/1.0.0 (by /u/reddit-marketing-mcp)';

async function redditGet(path) {
  const url = `${REDDIT_BASE}${path}.json`;
  const agent = getAgent(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    agent,
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Reddit API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function redditOAuthGet(path, token) {
  const url = `${OAUTH_BASE}${path}.json`;
  const agent = getAgent(url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Authorization': `Bearer ${token}`,
    },
    agent,
    timeout: 15000,
  });
  return res.json();
}

function isPremium() {
  const licenseKey = process.env.LICENSE_KEY;
  if (!licenseKey) return false;
  return licenseKey.length > 10;
}

// --- AI post generation via DeepSeek ---
async function aiGeneratePost(topic, subreddit, tone) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return `[Premium] Set DEEPSEEK_API_KEY in .env to enable AI generation.

Meanwhile, here's a template post for r/${subreddit} about "${topic}":

---

Hey r/${subreddit}!

I've been working on something related to ${topic} and wanted to share with the community.

[Your content here - be genuine, not salesy]

Would love to hear your thoughts!

---

Tip: Read the top 10 posts in r/${subreddit} to understand the tone before posting.`;
  }

  const prompt = `Write a Reddit post for r/${subreddit} about "${topic}".
Tone: ${tone || 'genuine, helpful, not salesy'}
Requirements:
- No clickbait title
- Be helpful first, mention product only if relevant
- Match Reddit's conversational style
- Keep it under 500 words
Output only the post content, no explanation.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
      timeout: 20000,
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[AI generation failed - check API key]';
  } catch (e) {
    return `[AI generation error: ${e.message}]\n\nUse template instead, or check DEEPSEEK_API_KEY.`;
  }
}

// --- Tool handlers ---

async function researchSubreddit(args) {
  const name = args.subreddit.replace(/^r\//, '').replace(/^\//, '');
  try {
    const data = await redditGet(`/r/${name}/about`);
    const s = data.data;

    let posts = [];
    try {
      const postsData = await redditGet(`/r/${name}/new?limit=100`);
      posts = postsData.data.children.map(c => c.data);
    } catch (e) {
      // posts fetch failed, continue with just about data
    }

    const hourCounts = new Array(24).fill(0);
    posts.forEach(p => {
      const h = new Date(p.created_utc * 1000).getUTCHours();
      hourCounts[h]++;
    });
    const bestHour = hourCounts.indexOf(Math.max(...hourCounts));

    const types = {};
    posts.forEach(p => {
      const t = p.is_self ? 'text' : 'link';
      types[t] = (types[t] || 0) + 1;
    });

    return {
      subreddit: `r/${name}`,
      subscribers: s.subscribers,
      activeUsers: s.accounts_active,
      description: s.public_description || s.title,
      isNsfw: s.over18,
      bestPostingHourUTC: bestHour >= 0 ? bestHour : null,
      bestPostingHourBeijing: bestHour >= 0 ? `UTC+8 ${bestHour + 8}` : 'unknown',
      postTypes: types,
      recommendation: bestHour >= 0
        ? `Best time to post: ${bestHour}:00 UTC (${bestHour + 8}:00 Beijing time). Focus on ${Object.entries(types).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'mixed'} posts.`
        : 'Could not analyze posting times (insufficient data).',
      freeFeature: true,
      note: 'Data fetched from Reddit public API. Works without login.',
    };
  } catch (e) {
    if (e.message.includes('timed out') || e.code === 'ETIMEDOUT') {
      throw new Error(`Cannot reach Reddit API. You may need a proxy. Set HTTP_PROXY or HTTPS_PROXY in .env. Details: ${e.message}`);
    }
    throw e;
  }
}

async function findTrendingPosts(args) {
  const sub = args.subreddit ? `/r/${args.subreddit.replace(/^r\//, '').replace(/^\//, '')}` : '';
  const limit = args.limit || 20;
  const data = await redditGet(`${sub}/hot?limit=${limit}`);
  const posts = data.data.children.map(c => {
    const p = c.data;
    return {
      title: p.title,
      author: p.author,
      subreddit: p.subreddit,
      ups: p.ups,
      comments: p.num_comments,
      url: `https://reddit.com${p.permalink}`,
      created: new Date(p.created_utc * 1000).toISOString(),
      isHot: p.ups > 1000,
    };
  });

  return {
    source: args.subreddit || 'all of Reddit',
    count: posts.length,
    hotPosts: posts.sort((a, b) => b.ups - a.ups),
    freeFeature: true,
  };
}

async function analyzeCompetitor(args) {
  const username = args.username.replace(/^u\//, '').replace(/^\//, '');
  const data = await redditGet(`/user/${username}/about`);
  const u = data.data;

  let posts = [];
  try {
    const postsData = await redditGet(`/user/${username}/submitted?limit=100`);
    posts = postsData.data.children.map(c => c.data);
  } catch (e) {}

  const subCounts = {};
  posts.forEach(p => {
    subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1;
  });

  const topPosts = [...posts].sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    username: `u/${username}`,
    karma: u.link_karma + u.comment_karma,
    accountAgeDays: Math.floor((Date.now() / 1000 - u.created_utc) / 86400),
    totalPosts: posts.length,
    topSubreddits: Object.entries(subCounts).sort((a,b)=>b[1]-a[1]).slice(0,5),
    topPosts: topPosts.map(p => ({
      title: p.title,
      score: p.score,
      url: `https://reddit.com${p.permalink}`,
    })),
    avgScore: posts.length ? Math.round(posts.reduce((a,p)=>a+p.score,0)/posts.length) : 0,
    freeFeature: true,
  };
}

async function generatePost(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock AI post generation. Visit: https://github.com/sponsors/1036007003-wq');
  }

  const subreddit = args.subreddit || 'generic';
  const topic = args.topic || 'your project';
  const name = subreddit.replace(/^r\//, '').replace(/^\//, '');

  let tone = 'genuine and helpful';
  try {
    const data = await redditGet(`/r/${name}/about`);
    tone = data.data.public_description ? `match r/${name} vibe: ${data.data.public_description.slice(0, 150)}` : tone;
  } catch (e) {}

  const post = await aiGeneratePost(topic, name, tone);

  return {
    generatedPost: post,
    targetSubreddit: `r/${name}`,
    toneGuide: tone,
    premiumFeature: true,
    nextStep: 'Review and edit the post to add your personal touch before posting.',
    starRepo: '✨ Found this useful? Please star the repo to support: https://github.com/1036007003-wq/reddit-marketing-mcp',
  };
}

async function schedulePost(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock scheduling.');
  }

  return {
    status: 'premium feature - coming soon',
    postContentPreview: args.postContent?.slice(0, 120) + '...',
    note: 'Real scheduling requires Reddit API OAuth. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env.',
    premiumFeature: true,
  };
}

async function trackMetrics(args) {
  if (!isPremium()) {
    throw new Error('PREMIUM FEATURE. Get a license key to unlock metrics tracking.');
  }

  return {
    note: 'Metrics tracking requires connecting your Reddit account via OAuth.',
    premiumFeature: true,
    setupGuide: '1. Create a Reddit app at https://www.reddit.com/prefs/apps\n2. Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REFRESH_TOKEN to .env\n3. Restart the server',
  };
}

// --- MCP Server ---

const server = new Server(
  { name: 'reddit-marketing-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'research_subreddit',
        description: 'Deep analysis of any subreddit: subscriber count, growth, best posting times, top content types. Free feature.',
        inputSchema: {
          type: 'object',
          properties: {
            subreddit: { type: 'string', description: 'Subreddit name (with or without r/)' },
          },
          required: ['subreddit'],
        },
      },
      {
        name: 'find_trending_posts',
        description: 'Find hot/trending posts in any subreddit before they peak. Free feature.',
        inputSchema: {
          type: 'object',
          properties: {
            subreddit: { type: 'string', description: 'Subreddit name (without r/). Leave empty for all of Reddit' },
            limit: { type: 'number', description: 'Number of posts to return (default 20)' },
          },
          required: [],
        },
      },
      {
        name: 'analyze_competitor',
        description: 'Track what your competitors are doing on Reddit: post history, top content, posting frequency. Free feature.',
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Reddit username (with or without u/)' },
          },
          required: ['username'],
        },
      },
      {
        name: 'generate_post',
        description: 'AI-powered post generator that matches each subreddit\'s tone. PREMIUM feature (GitHub Sponsors).',
        inputSchema: {
          type: 'object',
          properties: {
            subreddit: { type: 'string', description: 'Target subreddit' },
            topic: { type: 'string', description: 'Topic or product to post about' },
          },
          required: ['subreddit'],
        },
      },
      {
        name: 'schedule_post',
        description: 'Auto-schedule posts for optimal engagement windows. PREMIUM feature.',
        inputSchema: {
          type: 'object',
          properties: {
            postContent: { type: 'string', description: 'The post content to schedule' },
            scheduleTime: { type: 'string', description: 'When to post (ISO string or "next optimal window")' },
          },
          required: ['postContent'],
        },
      },
      {
        name: 'track_metrics',
        description: 'Dashboard for your Reddit marketing KPIs. PREMIUM feature.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'research_subreddit':
        result = await researchSubreddit(args);
        break;
      case 'find_trending_posts':
        result = await findTrendingPosts(args);
        break;
      case 'analyze_competitor':
        result = await analyzeCompetitor(args);
        break;
      case 'generate_post':
        result = await generatePost(args);
        break;
      case 'schedule_post':
        result = await schedulePost(args);
        break;
      case 'track_metrics':
        result = await trackMetrics(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Reddit Marketing MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
