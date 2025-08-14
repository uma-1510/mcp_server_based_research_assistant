export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
};

export type PageExtract = {
  url: string;
  title?: string;
  textContent?: string;
  html?: string;
  length?: number;
};

export type ResearchFinding = {
  url: string;
  title?: string;
  excerpt?: string;
};

export type ResearchReport = {
  query: string;
  createdAt: string;
  findings: ResearchFinding[];
  summaryMarkdown?: string;
  sources: SearchResult[];
};
