import { fetchJson } from './http.js';

export interface GithubConfig {
  token: string;
  baseUrl?: string;
}

export class GithubClient {
  private readonly base: string;
  private readonly headers: HeadersInit;

  constructor(private readonly cfg: GithubConfig) {
    this.base = cfg.baseUrl ?? 'https://api.github.com';
    this.headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'opssage/0.1',
    };
  }

  /** Search code across the repos the token can see. */
  searchCode(q: string, opts?: { perPage?: number }): Promise<GithubCodeSearch> {
    const u = new URL('/search/code', this.base);
    u.searchParams.set('q', q);
    if (opts?.perPage) u.searchParams.set('per_page', String(opts.perPage));
    return fetchJson(u.toString(), { headers: this.headers });
  }

  /** List recently merged PRs touching a path. */
  recentPullRequests(repo: string, sinceIso: string): Promise<GithubPullRequest[]> {
    const u = new URL(`/repos/${repo}/pulls`, this.base);
    u.searchParams.set('state', 'closed');
    u.searchParams.set('sort', 'updated');
    u.searchParams.set('direction', 'desc');
    u.searchParams.set('per_page', '30');
    return fetchJson<GithubPullRequest[]>(u.toString(), { headers: this.headers }).then((all) =>
      all.filter((pr) => pr.merged_at && pr.merged_at >= sinceIso),
    );
  }

  /** Blame a file via the GraphQL API. */
  async blame(repo: string, branch: string, path: string): Promise<GithubBlameRange[]> {
    const [owner, name] = repo.split('/', 2);
    if (!owner || !name) throw new Error(`bad repo "${repo}", expected "owner/name"`);
    const query = `
      query Blame($owner: String!, $name: String!, $expression: String!) {
        repository(owner: $owner, name: $name) {
          object(expression: $expression) {
            ... on Commit {
              blame(path: $path) {
                ranges {
                  startingLine
                  endingLine
                  age
                  commit {
                    oid
                    message
                    committedDate
                    author { name email }
                  }
                }
              }
            }
          }
        }
      }`;
    const res = await fetchJson<GithubGraphQLResponse>(`${this.base}/graphql`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, expression: branch, path } }),
    });
    return res.data?.repository?.object?.blame?.ranges ?? [];
  }
}

export interface GithubCodeSearch {
  total_count?: number;
  items?: Array<{
    name?: string;
    path?: string;
    repository?: { full_name?: string; html_url?: string };
    html_url?: string;
  }>;
}

export interface GithubPullRequest {
  number?: number;
  title?: string;
  html_url?: string;
  user?: { login?: string };
  merged_at?: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

export interface GithubBlameRange {
  startingLine: number;
  endingLine: number;
  age: number;
  commit: {
    oid: string;
    message: string;
    committedDate: string;
    author?: { name?: string; email?: string };
  };
}

interface GithubGraphQLResponse {
  data?: {
    repository?: {
      object?: { blame?: { ranges?: GithubBlameRange[] } };
    };
  };
}
