export interface WikiNode {
  id: string;
  title: string;
  url: string;
  depth: number;
  inDegree: number;
  outDegree: number;
  pagerank: number;
  betweenness: number;
  communityId: number;
}

export interface WikiEdge {
  source: string;
  target: string;
}

export type WikiConnectionContext = 'lead' | 'article' | 'see_also';

export interface WikiRelationship {
  source: string;
  target: string;
  relation: string;
  context: WikiConnectionContext | null;
  explanation: string;
  evidence: string | null;
  section: string | null;
  sourceUrl: string;
  sourceContextFound: boolean;
}

export interface Community {
  id: number;
  label: string;
  size: number;
  topPages: string[];
}

export interface CrawlProgress {
  done: number;
  target: number;
}

export interface CrawlTruncation {
  /** 'budget' when the request budget was exhausted (wins over 'upstream'), else 'upstream'. */
  reason: 'budget' | 'upstream';
  /** Titles of pages that were not fully fetched (failed or never processed). */
  titles: string[];
}

export interface NodeMetrics {
  pagerank: number;
  betweenness: number;
  communityId: number;
  inDegree: number;
  outDegree: number;
}

export interface CrawlResult {
  id: string;
  seedId: string;
  nodes: WikiNode[];
  edges: WikiEdge[];
  communities: Community[];
  crawledAt: string;
  positions: { [key: string]: { x: number; y: number } };
  progress?: CrawlProgress;
  partial?: boolean;
  failedTitles?: string[];
  /** Present when `partial` is true: why the crawl was cut short and which pages are missing. */
  truncation?: CrawlTruncation;
  /** Metrics for every node of the merged graph (known + new nodes) on expand responses. */
  metrics?: { [nodeId: string]: NodeMetrics };
}

export interface SearchResult {
  title: string;
  url: string;
  extract?: string;
}

export interface PathResult {
  path: string[];
  length: number;
}

export interface CrawlRequest {
  seedTitle: string;
  depth: number;
  maxNodes: number;
  /** IDs of nodes already present in the client's graph; present only for expand requests. */
  knownNodeIds?: string[];
  /** Known edges as index pairs into `knownNodeIds`, used to recompute analysis without resending edges. */
  knownEdgeIndexPairs?: [number, number][];
  /** Depth of the node being expanded within the original graph. */
  baseDepth?: number;
}
