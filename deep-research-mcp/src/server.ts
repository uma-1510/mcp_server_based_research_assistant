import 'dotenv/config';
import { z } from 'zod';
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import pLimit from 'p-limit';
import { OpenAI } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { type SearchResult, type PageExtract, type ResearchReport } from './types';

async function webSearch(query: string, maxResults = 10): Promise<SearchResult[]> {
	const perplexityKey = process.env.PERPLEXITY_API_KEY;
	if (perplexityKey) {
		const resp = await fetch('https://api.perplexity.ai/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${perplexityKey}`,
			},
			body: JSON.stringify({
				model: 'sonar-reasoning-pro',
				messages: [
					{
						role: 'user',
						content: `Return a JSON array of up to ${maxResults} high-quality links for: ${query}. Only JSON with objects: {title, url, snippet}.`,
					},
				],
				return_citations: true,
			}),
		});
		try {
			const data: any = await resp.json();
			const text: string = data?.choices?.[0]?.message?.content ?? '';
			const jsonStart = text.indexOf('[');
			const jsonEnd = text.lastIndexOf(']');
			if (jsonStart >= 0 && jsonEnd > jsonStart) {
				const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
				return parsed?.slice(0, maxResults) ?? [];
			}
		} catch {}
	}
	const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, { headers: { 'User-Agent': 'MCP-Research/1.0' } });
	const html = await res.text();
	const $ = cheerio.load(html);
	const items: SearchResult[] = [];
	$('td.result-link a').each((_, el) => {
		const title = $(el).text().trim();
		const href = $(el).attr('href') || '';
		if (title && href && items.length < maxResults) {
			items.push({ title, url: href, source: 'duckduckgo' });
		}
	});
	return items;
}

async function fetchPage(url: string): Promise<PageExtract> {
	const res = await fetch(url, { headers: { 'User-Agent': 'MCP-Research/1.0' } });
	const html = await res.text();
	const dom = new JSDOM(html, { url });
	const reader = new Readability(dom.window.document);
	const article = reader.parse();
	const title = article?.title || dom.window.document.title || url;
	const textContent = article?.textContent || dom.window.document.body.textContent || '';
	return { url, title, textContent, html, length: textContent.length };
}

async function summarizeFindings(findings: PageExtract[], query: string): Promise<string | undefined> {
	const openaiKey = process.env.OPENAI_API_KEY;
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const system = 'You are a careful research assistant. Produce a concise, well-structured markdown summary with citations [#]. Include key findings, disagreements, and uncertainties. Avoid speculation.';
	const context = findings
		.slice(0, 8)
		.map((p, i) => `[#${i + 1}] ${p.title}\nURL: ${p.url}\nExcerpt: ${p.textContent?.slice(0, 1000)}`)
		.join('\n\n');
	const prompt = `Research question: ${query}\n\nSources:\n${context}\n\nWrite the summary now.`;
	try {
		if (anthropicKey) {
			const client = new Anthropic({ apiKey: anthropicKey });
			const msg = await client.messages.create({
				model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
				max_tokens: 1200,
				system,
				messages: [{ role: 'user', content: prompt }],
			});
			return msg.content?.[0]?.type === 'text' ? (msg.content[0] as any).text : undefined;
		}
		if (openaiKey) {
			const openai = new OpenAI({ apiKey: openaiKey });
			const resp = await openai.chat.completions.create({
				model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: prompt },
				],
				temperature: 0.2,
			});
			return resp.choices?.[0]?.message?.content || undefined;
		}
	} catch {}
	return undefined;
}

async function deepResearch(
	query: string,
	opts?: { maxResults?: number; maxPages?: number; concurrency?: number }
) {
	const maxResults = opts?.maxResults ?? 12;
	const maxPages = opts?.maxPages ?? 8;
	const concurrency = opts?.concurrency ?? 4;
	const results = await webSearch(query, maxResults);
	const limit = pLimit(concurrency);
	const pages: PageExtract[] = (
		await Promise.all(
			results
				.slice(0, maxPages)
				.map((r) => limit(() => fetchPage(r.url).catch(() => ({ url: r.url, title: r.title } as PageExtract))) )
		)
	).filter(Boolean) as PageExtract[];
	const findings = pages.map((p) => ({ url: p.url, title: p.title, excerpt: p.textContent?.slice(0, 400) }));
	const summaryMarkdown = await summarizeFindings(pages, query);
	const report: ResearchReport = {
		query,
		createdAt: new Date().toISOString(),
		findings,
		summaryMarkdown,
		sources: results,
	};
	return report;
}

async function main() {
	const mcpMod = await import(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js', import.meta.url).toString());
	const stdioMod = await import(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', import.meta.url).toString());
	const { McpServer, ResourceTemplate } = mcpMod as any;
	const { StdioServerTransport } = stdioMod as any;

	const server = new McpServer(
		{ name: 'deep-research-mcp', version: '0.1.0' },
		{
			capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
			instructions: 'Use the tools to search and compile deep research with citations.',
		}
	);

	server.tool(
		'search_web',
		'Search the web for a query and return top results',
		{
			query: z.string().min(1),
			maxResults: z.number().int().min(1).max(20).optional(),
		},
		async (args: any) => {
			const { query, maxResults } = args as { query: string; maxResults?: number };
			const results = await webSearch(query, maxResults ?? 10);
			return {
				content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
				structuredContent: results,
			};
		}
	);

	server.tool(
		'fetch_url',
		'Fetch and extract readability content from a URL',
		{ url: z.string().url() },
		async (args: any) => {
			const { url } = args as { url: string };
			const page = await fetchPage(url);
			return {
				content: [{ type: 'text', text: JSON.stringify(page, null, 2) }],
				structuredContent: page,
			};
		}
	);

	server.tool(
		'deep_research',
		'Perform multi-source research and produce a markdown summary with citations',
		{
			query: z.string().min(3),
			maxResults: z.number().int().min(1).max(25).optional(),
			maxPages: z.number().int().min(1).max(15).optional(),
			concurrency: z.number().int().min(1).max(8).optional(),
		},
		async (args: any) => {
			const { query, maxResults, maxPages, concurrency } = args as {
				query: string;
				maxResults?: number;
				maxPages?: number;
				concurrency?: number;
			};
			const report = await deepResearch(query, { maxResults, maxPages, concurrency });
			const fileBase = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
			const dir = process.env.RESEARCH_DIR || '/workspace/deep-research-mcp/research';
			const path = `${dir}/${fileBase}-${Date.now()}.md`;
			const md = [
				`# Research: ${query}`,
				`Date: ${report.createdAt}`,
				'',
				report.summaryMarkdown ?? 'Summary not available (no model configured).',
				'',
				'## Sources',
				...report.sources.map((s, i) => `- [#${i + 1}] ${s.title} (${s.url})`),
			].join('\n');
			const fs = await import('node:fs/promises');
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path, md, 'utf-8');
			return {
				content: [{ type: 'text', text: md }],
				structuredContent: report,
			};
		}
	);

	server.registerResource(
		'research-files',
		new ResourceTemplate('file:///workspace/deep-research-mcp/research/{name}', {
			list: async () => {
				const fs = await import('node:fs/promises');
				const dir = '/workspace/deep-research-mcp/research';
				await fs.mkdir(dir, { recursive: true });
				const files = await fs.readdir(dir);
				return {
					resources: files
						.filter((f) => f.endsWith('.md'))
						.map((f) => ({ uri: `file://${dir}/${f}`, name: f, mimeType: 'text/markdown' })),
				};
			},
		}),
		async (uri: URL) => {
			const fs = await import('node:fs/promises');
			const path = uri.pathname;
			const text = await fs.readFile(path, 'utf-8');
			return {
				contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text }],
			};
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error('Server error:', err);
	process.exit(1);
});